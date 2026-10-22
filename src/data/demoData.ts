import type {
  ChartPoint,
  Product,
  Transaction,
} from '../types'

export const transactions: Transaction[] = [
  {
    id: '#MT-1048',
    customer: 'أحمد محمد',
    initials: 'أم',
    color: 'blue',
    date: '10:42 ص',
    amount: 2450,
    status: 'completed',
  },
  {
    id: '#MT-1047',
    customer: 'سارة إبراهيم',
    initials: 'سإ',
    color: 'pink',
    date: '10:18 ص',
    amount: 1280,
    status: 'completed',
  },
  {
    id: '#MT-1046',
    customer: 'محمود علي',
    initials: 'مع',
    color: 'green',
    date: '09:56 ص',
    amount: 850,
    status: 'pending',
  },
  {
    id: '#MT-1045',
    customer: 'نور خالد',
    initials: 'نك',
    color: 'purple',
    date: '09:31 ص',
    amount: 3600,
    status: 'completed',
  },
  {
    id: '#MT-1044',
    customer: 'عمر حسن',
    initials: 'عح',
    color: 'orange',
    date: '09:12 ص',
    amount: 640,
    status: 'cancelled',
  },
]

export const products: Product[] = [
  {
    id: 'PR-001',
    name: 'منتج تجريبي أ',
    category: 'التصنيف الأول',
    stock: 8,
    sales: 124,
  },
  {
    id: 'PR-002',
    name: 'منتج تجريبي ب',
    category: 'التصنيف الثاني',
    stock: 12,
    sales: 98,
  },
  {
    id: 'PR-003',
    name: 'منتج تجريبي ج',
    category: 'التصنيف الأول',
    stock: 4,
    sales: 76,
  },
]

export const chartData: ChartPoint[] = [
  { day: 'saturday', value: 38 },
  { day: 'sunday', value: 57 },
  { day: 'monday', value: 44 },
  { day: 'tuesday', value: 72 },
  { day: 'wednesday', value: 53 },
  { day: 'thursday', value: 88 },
  { day: 'friday', value: 67 },
]