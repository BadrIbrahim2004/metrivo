export type Language = 'ar' | 'en'

export type PageKey =
  | 'dashboard'
  | 'sales'
  | 'products'
  | 'inventory'
  | 'customers'
  | 'suppliers'
  | 'finance'
  | 'reports'
  | 'settings'

export type TransactionStatus =
  | 'completed'
  | 'pending'
  | 'cancelled'

export interface Transaction {
  id: string
  customer: string
  initials: string
  color: string
  date: string
  amount: number
  status: TransactionStatus
}

export interface Product {
  id: string
  name: string
  category: string
  stock: number
  sales: number
}

export interface ChartPoint {
  day: string
  value: number
}

export interface StatItem {
  id: string
  value: number
  change: number
}