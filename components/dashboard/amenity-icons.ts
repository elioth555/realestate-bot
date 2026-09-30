import {
  ArrowUpDown,
  Car,
  DoorOpen,
  Dumbbell,
  PawPrint,
  ShieldCheck,
  Sofa,
  Sun,
  Sunset,
  Trees,
  Waves,
  type LucideIcon,
} from 'lucide-react'
import type { AmenityKey } from '@/lib/listings'

export const AMENITY_ICONS: Record<AmenityKey, LucideIcon> = {
  parking: Car,
  mamad: ShieldCheck,
  balcony: DoorOpen,
  elevator: ArrowUpDown,
  furnished: Sofa,
  terrace: Sun,
  garden: Trees,
  pool: Waves,
  gym: Dumbbell,
  seaView: Sunset,
  petFriendly: PawPrint,
}
