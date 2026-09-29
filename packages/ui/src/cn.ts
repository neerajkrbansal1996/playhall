import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind-aware class joiner. The shadcn/ui convention, shared repo-wide. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
