import { Bell, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SourceDot } from './source-badge'

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 md:px-6">
        <a href="/" className="flex items-center gap-2.5" aria-label="RealEstateBot home">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight">
            RealEstate<span className="text-primary">Bot</span>
          </span>
        </a>

        <div className="hidden items-center gap-4 rounded-full border bg-background px-4 py-1.5 text-xs text-muted-foreground md:flex">
          <span className="font-medium text-foreground">Live sources</span>
          <span className="flex items-center gap-1.5">
            <SourceDot source="facebook" /> Facebook
          </span>
          <span className="flex items-center gap-1.5">
            <SourceDot source="yad2" /> Yad2
          </span>
          <span className="flex items-center gap-1.5">
            <SourceDot source="madlan" /> Madlan
          </span>
          <span className="border-l pl-4">Synced 2 min ago</span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
            <Bell className="size-4" aria-hidden="true" />
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
          </Button>
          <div className="flex items-center gap-2.5 border-l pl-3">
            <span
              className="flex size-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
              aria-hidden="true"
            >
              DL
            </span>
            <div className="hidden leading-tight sm:block">
              <p className="text-sm font-medium">Dana Levi</p>
              <p className="text-xs text-muted-foreground">Licensed agent</p>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
