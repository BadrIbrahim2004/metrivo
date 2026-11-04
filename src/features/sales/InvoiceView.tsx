import { useEffect, useMemo, useRef } from 'react'
import {
  AtSign,
  BriefcaseBusiness,
  Camera,
  CirclePlay,
  Ghost,
  Globe,
  MapPin,
  MessageCircle,
  Music2,
  Phone,
  Printer,
  Send,
  UsersRound,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language } from '../../types'
import type { ReceiptSettings } from './receipt-settings'

export interface InvoiceItem {
  productName: string
  productSku: string
  quantity: number
  unitPrice: string
  lineTotal: string
}

export interface InvoiceData {
  invoiceNumber: string
  subtotal?: string
  discount?: string
  surcharge?: string
  customerName?: string | null
  adjustmentReason?: string | null
  cashReceived?: string | null
  changeDue?: string | null
  total: string
  createdAt: string | Date
  paymentMethod?: string
  items: InvoiceItem[]
}

interface InvoiceViewProps {
  invoice: InvoiceData
  branchName: string
  cashierName?: string
  receiptSettings?: ReceiptSettings | null
  language: Language
  t: AppTranslations
  autoPrint?: boolean
  onClose: () => void
}

function money(centsValue: number, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    currencyDisplay: 'code',
  }).format(centsValue / 100)
}

function cents(amount: string): number {
  return Math.round(Number(amount) * 100)
}

export default function InvoiceView({
  invoice,
  branchName,
  cashierName,
  receiptSettings,
  language,
  t,
  autoPrint = false,
  onClose,
}: InvoiceViewProps) {
  const copy = t.invoice
  const onCloseRef = useRef(onClose)
  const logoDataUrl = receiptSettings?.receiptLogoDataUrl
  const displayName = receiptSettings?.receiptDisplayName
  const hasAdjustment =
    cents(invoice.discount ?? '0') > 0 || cents(invoice.surcharge ?? '0') > 0

  const printedAt = useMemo(
    () => new Date().toLocaleString(numberLocale(language)),
    [language],
  )
  const socialLinks: Array<{
    label: string
    value: string | null
    icon: LucideIcon
    className: string
  }> = [
    { label: t.ui.receiptFacebookLabel, value: receiptSettings?.receiptFacebook ?? null, icon: UsersRound, className: 'facebook' },
    { label: t.ui.receiptInstagramLabel, value: receiptSettings?.receiptInstagram ?? null, icon: Camera, className: 'instagram' },
    { label: t.ui.receiptTiktokLabel, value: receiptSettings?.receiptTiktok ?? null, icon: Music2, className: 'tiktok' },
    { label: t.ui.receiptYoutubeLabel, value: receiptSettings?.receiptYoutube ?? null, icon: CirclePlay, className: 'youtube' },
    { label: t.ui.receiptWhatsappLabel, value: receiptSettings?.receiptWhatsapp ?? null, icon: MessageCircle, className: 'whatsapp' },
    { label: t.ui.receiptXLabel, value: receiptSettings?.receiptX ?? null, icon: AtSign, className: 'x' },
    { label: t.ui.receiptTelegramLabel, value: receiptSettings?.receiptTelegram ?? null, icon: Send, className: 'telegram' },
    { label: t.ui.receiptSnapchatLabel, value: receiptSettings?.receiptSnapchat ?? null, icon: Ghost, className: 'snapchat' },
    { label: t.ui.receiptLinkedinLabel, value: receiptSettings?.receiptLinkedin ?? null, icon: BriefcaseBusiness, className: 'linkedin' },
    { label: t.ui.receiptWebsiteLabel, value: receiptSettings?.receiptWebsite ?? null, icon: Globe, className: 'website' },
  ]

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!autoPrint) return

    const handleAfterPrint = () => onCloseRef.current()
    window.addEventListener('afterprint', handleAfterPrint)
    const timer = window.setTimeout(() => window.print(), 250)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('afterprint', handleAfterPrint)
    }
  }, [autoPrint, invoice.invoiceNumber])

  function print() {
    window.print()
  }

  return (
    <div
      className={`invoice-overlay${autoPrint ? ' invoice-auto-print' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
    >
      <div className="invoice-dialog invoice-80mm" dir={language === 'ar' ? 'rtl' : 'ltr'}>
        <div className="invoice-toolbar no-print">
          <span className="invoice-width-picker">{copy.width80}</span>
          <div className="invoice-toolbar-actions">
            <button type="button" className="button-primary" onClick={print}>
              <Printer size={16} aria-hidden="true" /> {copy.print}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
              aria-label={copy.close}
            >
              <X size={16} aria-hidden="true" /> {copy.close}
            </button>
          </div>
        </div>

        <div className="invoice-paper" aria-label={copy.title}>
          <header className="invoice-header">
            {logoDataUrl ? (
              <img
                className="invoice-logo"
                src={logoDataUrl}
                alt=""
              />
            ) : null}
            {!logoDataUrl && displayName ? (
              <p className="invoice-shop invoice-shop-primary">{displayName}</p>
            ) : null}
            {logoDataUrl ? (
              displayName || branchName ? (
                <div className="invoice-brand-details">
                  {displayName ? <p className="invoice-shop">{displayName}</p> : null}
                  {branchName ? <p className="invoice-branch">{branchName}</p> : null}
                </div>
              ) : null
            ) : branchName ? (
              <p className="invoice-branch">{branchName}</p>
            ) : null}
            {cashierName ? <p className="invoice-cashier">{cashierName}</p> : null}
          </header>

          <dl className="invoice-meta">
            <div>
              <dt>{copy.invoiceNumber}</dt>
              <dd>{invoice.invoiceNumber}</dd>
            </div>
            <div>
              <dt>{copy.date}</dt>
              <dd>
                {new Date(invoice.createdAt).toLocaleString(
                  numberLocale(language),
                )}
              </dd>
            </div>
            {invoice.customerName ? (
              <div>
                <dt>{copy.customer}</dt>
                <dd>{invoice.customerName}</dd>
              </div>
            ) : null}
            {invoice.paymentMethod ? (
              <div>
                <dt>{copy.paymentMethod}</dt>
                <dd>{({
                  CASH: t.ui.posPayCash,
                  INSTAPAY: t.ui.posPayInstapay,
                  WALLET: t.ui.posPayWallet,
                  FAWRY: t.ui.posPayFawry,
                  CARD: t.ui.posPayCard,
                  BANK_TRANSFER: t.ui.posPayBank,
                  OTHER: t.salesManagement.other,
                } as Record<string, string>)[invoice.paymentMethod] ?? invoice.paymentMethod}</dd>
              </div>
            ) : null}
          </dl>

          <table className="invoice-lines">
            <thead>
              <tr>
                <th scope="col">{copy.item}</th>
                <th scope="col" className="num">{copy.qty}</th>
                <th scope="col" className="num">{copy.unitPrice}</th>
                <th scope="col" className="num">{copy.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item, index) => (
                <tr key={`${item.productSku}-${index}`}>
                  <td>
                    <span className="invoice-item-name">{item.productName}</span>
                    <small className="invoice-item-sku">{item.productSku}</small>
                  </td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{money(cents(item.unitPrice), language)}</td>
                  <td className="num">{money(cents(item.lineTotal), language)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="invoice-totals">
            {hasAdjustment ? (
              <div>
                <dt>{copy.subtotal}</dt>
                <dd>{money(cents(invoice.subtotal ?? invoice.total ?? '0'), language)}</dd>
              </div>
            ) : null}
            {cents(invoice.discount ?? '0') > 0 ? (
              <div>
                <dt>{copy.discount}</dt>
                <dd>-{money(cents(invoice.discount ?? '0'), language)}</dd>
              </div>
            ) : null}
            {cents(invoice.surcharge ?? '0') > 0 ? (
              <div>
                <dt>{copy.surcharge}</dt>
                <dd>+{money(cents(invoice.surcharge ?? '0'), language)}</dd>
              </div>
            ) : null}
            {invoice.adjustmentReason ? (
              <div>
                <dt>{copy.adjustmentReason}</dt>
                <dd>{invoice.adjustmentReason}</dd>
              </div>
            ) : null}
            <div className="invoice-grand">
              <dt>{copy.total}</dt>
              <dd>{money(cents(invoice.total), language)}</dd>
            </div>
            {invoice.cashReceived || (invoice.changeDue !== null && invoice.changeDue !== undefined) ? (
              <div className="invoice-cash-summary">
                {invoice.cashReceived ? (
                  <>
                    <dt>{copy.cashReceived}</dt>
                    <dd>{money(cents(invoice.cashReceived), language)}</dd>
                  </>
                ) : null}
                {invoice.changeDue !== null && invoice.changeDue !== undefined ? (
                  <>
                    <dt>{copy.changeDue}</dt>
                    <dd>{money(cents(invoice.changeDue), language)}</dd>
                  </>
                ) : null}
              </div>
            ) : null}
          </dl>

          <footer className="invoice-footer">
            {receiptSettings?.receiptPhone ? (
              <p className="invoice-contact">
                <Phone size={14} aria-hidden="true" />
                <strong>{copy.phone}:</strong> {receiptSettings.receiptPhone}
              </p>
            ) : null}
            {receiptSettings?.receiptAddress ? (
              <p className="invoice-contact">
                <MapPin size={14} aria-hidden="true" />
                <strong>{copy.address}:</strong> {receiptSettings.receiptAddress}
              </p>
            ) : null}
            <div className="invoice-socials">
              {socialLinks.filter(({ value }) => value).map(({ label, value, icon: Icon, className }) => (
                <p className={`invoice-contact invoice-social invoice-social-${className}`} key={className}>
                  <Icon size={14} aria-hidden="true" />
                  <strong>{label}:</strong> {value}
                </p>
              ))}
            </div>
            <p>{copy.thankYou}</p>
            <p className="invoice-printed">{copy.printedAt}: {printedAt}</p>
          </footer>
        </div>
      </div>
    </div>
  )
}
