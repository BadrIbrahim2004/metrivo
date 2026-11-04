import type { ChangeEvent, PropsWithChildren } from 'react'
import { toLatinDigits } from '../i18n/numbers'

export default function DigitNormalizationBoundary({ children }: PropsWithChildren) {
  function normalizeInput(event: ChangeEvent<HTMLDivElement>) {
    const target = event.target
    if (target instanceof HTMLInputElement) {
      if (['button', 'checkbox', 'file', 'hidden', 'image', 'password', 'radio', 'reset', 'submit'].includes(target.type)) {
        return
      }
      const value = toLatinDigits(target.value)
      if (value !== target.value) target.value = value
    } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      const value = toLatinDigits(target.value)
      if (value !== target.value) target.value = value
    }
  }

  return (
    <div style={{ display: 'contents' }} onChangeCapture={normalizeInput}>
      {children}
    </div>
  )
}
