/**
 * The one place the accessibility contract for a settings field is written down.
 *
 * ADR-0004 §9 makes the descriptor-driven form the floor precisely so that
 * "accessibility and design consistency" are "enforced once in the shell"
 * instead of audited per game. That promise is only worth anything if the label,
 * the `help` text and the server's error message are wired in a single component
 * that every field kind is obliged to use — so this is that component, and the
 * ids it hands back are the only ones a field kind may put in
 * `aria-describedby`.
 */

import { AlertCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface FieldIds {
  readonly labelId: string
  readonly controlId: string
  /** Space-separated ids for `aria-describedby`, or undefined when there is none. */
  readonly describedBy: string | undefined
  readonly hasError: boolean
}

/**
 * Derive every id a field needs from one prefix, so a page rendering two forms
 * (create-lobby and the waiting room's edit-settings) cannot collide.
 */
export function fieldIds(idPrefix: string, key: string, help: unknown, error: unknown): FieldIds {
  const base = `${idPrefix}-${key}`
  const described: string[] = []
  if (typeof help === 'string' && help.length > 0) described.push(`${base}-help`)
  if (typeof error === 'string' && error.length > 0) described.push(`${base}-error`)
  return {
    labelId: `${base}-label`,
    controlId: base,
    describedBy: described.length > 0 ? described.join(' ') : undefined,
    hasError: typeof error === 'string' && error.length > 0,
  }
}

/**
 * The DOM attributes that make a field observable to an E2E spec.
 *
 * Mechanical, and that is the whole point. The M2 E2E observable contract §2
 * fixes the name as `setting-<formFieldKey>` where the key is the literal `key:`
 * in the game's descriptor, so a new setting cannot ship without a testid and a
 * renamed key breaks the spec rather than silently un-testing the field. Rev 2
 * of that contract hand-named four of chess's six fields and lost `takebacks`
 * and `autoQueen` exactly that way.
 *
 * `data-value` is the other half — the contract's proof-selector rule says a
 * spec must assert the state it drove a form into *before* measuring anything,
 * so every field has to publish its committed value, not just its existence.
 * It is the value from `values`, never a re-read of the DOM, so what a spec
 * asserts is what would be submitted.
 *
 * Nothing here knows a game id, a slug or a field's meaning — see ADR-0004 §1.
 */
export function fieldTestAttributes(
  fieldKey: string,
  value: unknown,
): Record<`data-${string}`, string | undefined> {
  return {
    'data-testid': `setting-${fieldKey}`,
    'data-field-key': fieldKey,
    'data-value': settingTestValue(value),
  }
}

/**
 * Serialise a committed setting for `data-value`.
 *
 * `SettingsValue` is `string | number | boolean`; an attribute is a string. A
 * value the form has not got yet (a descriptor field with no default) omits the
 * attribute entirely rather than publishing `"undefined"`, so
 * `[data-testid="setting-x"]:not([data-value])` is a meaningful selector.
 *
 * Unlike `optionToken` this carries no type prefix: a spec asserts the player's
 * value (`custom`, `0.5`, `true`), not the renderer's internal lookup key.
 */
function settingTestValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? String(value) : undefined
    case 'boolean':
      return value ? 'true' : 'false'
    default:
      return undefined
  }
}

export interface FieldShellProps {
  readonly idPrefix: string
  readonly fieldKey: string
  /** The committed value, published as `data-value`. See `fieldTestAttributes`. */
  readonly value: unknown
  readonly label: string
  readonly help?: string
  readonly error?: string
  /**
   * `fieldset` for a control made of several inputs (a chip group), `div` for a
   * single input that owns its own `<label>`. A fieldset gets a `<legend>`,
   * which is how a screen reader announces the question before the choices.
   */
  readonly as: 'fieldset' | 'div'
  readonly children: React.ReactNode
  readonly className?: string
}

/**
 * Label, help text, error slot and the layout every field shares.
 *
 * The children are rendered by the field kind; everything around them is fixed.
 */
export function FieldShell({
  idPrefix,
  fieldKey,
  value,
  label,
  help,
  error,
  as,
  children,
  className,
}: FieldShellProps) {
  const ids = fieldIds(idPrefix, fieldKey, help, error)
  const Wrapper = as

  return (
    <Wrapper
      data-slot="settings-field"
      {...fieldTestAttributes(fieldKey, value)}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      {as === 'fieldset' ? (
        <legend id={ids.labelId} className="mb-2 text-sm font-medium">
          {label}
        </legend>
      ) : (
        <label id={ids.labelId} htmlFor={ids.controlId} className="text-sm font-medium">
          {label}
        </label>
      )}

      {children}

      {help !== undefined && help.length > 0 ? (
        <p id={`${ids.controlId}-help`} className="text-muted-foreground text-xs">
          {help}
        </p>
      ) : null}

      {/*
        Never colour alone: the error carries an icon and the word-level message,
        and `role="alert"` announces a server rejection that arrives after submit
        without the player having to go looking for it.
      */}
      {error !== undefined && error.length > 0 ? (
        <p
          id={`${ids.controlId}-error`}
          role="alert"
          className="text-destructive flex items-start gap-1.5 text-xs font-medium"
        >
          <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </Wrapper>
  )
}
