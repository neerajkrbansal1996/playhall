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

export interface FieldShellProps {
  readonly idPrefix: string
  readonly fieldKey: string
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
      data-field-key={fieldKey}
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
