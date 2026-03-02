import { Button } from "@/components/ui/button";
import { Heart, MessageCircle, Phone, Shield, RefreshCw } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-6 h-6 text-primary" />
            <span className="font-serif text-xl font-semibold tracking-tight" data-testid="text-logo">Lulou</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="/api/logout" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors" data-testid="link-switch-account">
              <RefreshCw className="w-3.5 h-3.5" />
              Switch Account
            </a>
            <a href="/api/login">
              <Button variant="ghost" data-testid="button-login">Log in</Button>
            </a>
            <a href="/api/login">
              <Button data-testid="button-get-started">Get Started</Button>
            </a>
          </div>
        </div>
      </nav>

      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, hsl(350 45% 52%) 0%, transparent 50%), radial-gradient(circle at 80% 50%, hsl(155 25% 45%) 0%, transparent 50%)'
        }} />
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8">
            <div className="space-y-4">
              <p className="text-sm font-medium tracking-wider uppercase text-primary" data-testid="text-tagline">Intentional Dating</p>
              <h1 className="font-serif text-5xl lg:text-6xl font-bold leading-tight tracking-tight" data-testid="text-hero-headline">
                Where real connections
                <span className="text-primary"> flourish</span>
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-lg" data-testid="text-hero-description">
                Move beyond endless swiping. Lulou guides you from matching to meaningful conversations to meeting in real life.
              </p>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <a href="/api/login">
                <Button size="lg" className="text-base px-8" data-testid="button-hero-cta">
                  Begin Your Journey
                </Button>
              </a>
            </div>
            <div className="flex items-center gap-6 flex-wrap text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                <span>Verified profiles</span>
              </div>
              <div className="flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                <span>No games</span>
              </div>
            </div>
          </div>

          <div className="relative hidden lg:block">
            <div className="relative rounded-md overflow-hidden aspect-[4/3]">
              <img
                src="/images/bloom-hero.png"
                alt="Lulou - Intentional Dating"
                className="w-full h-full object-cover"
                data-testid="img-hero"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background/20 to-transparent" />
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 px-6 bg-card/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16 space-y-3">
            <p className="text-sm font-medium tracking-wider uppercase text-primary">How It Works</p>
            <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-how-it-works">A journey, not a game</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">Every feature in Lulou is designed to move you toward a real connection, not keep you scrolling.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              icon={<LulouFlowerIcon className="w-5 h-5" />}
              title="Discover with intention"
              description="View one profile at a time. No swiping, no rush. Decide thoughtfully who you want to open up to."
              testId="card-feature-discover"
            />
            <FeatureCard
              icon={<MessageCircle className="w-5 h-5" />}
              title="Conversations that matter"
              description="Limited messages encourage meaningful exchanges. When it's time, Lulou nudges you toward a real call."
              testId="card-feature-message"
            />
            <FeatureCard
              icon={<Phone className="w-5 h-5" />}
              title="From screen to scene"
              description="Your first voice call is always free. Lulou is designed to help you meet, not message forever."
              testId="card-feature-call"
            />
          </div>
        </div>
      </section>

      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-cta-heading">Ready to find something real?</h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Lulou is for people who are done with the noise. Step into a calmer, more intentional way to date.
          </p>
          <a href="/api/login">
            <Button size="lg" className="text-base px-10 mt-4" data-testid="button-cta-bottom">
              Start Your Journey
            </Button>
          </a>
        </div>
      </section>

      <footer className="border-t py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-5 h-5 text-primary" />
            <span className="font-serif font-medium text-foreground">Lulou</span>
          </div>
          <p>Designed for real connection.</p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description, testId }: { icon: React.ReactNode; title: string; description: string; testId: string }) {
  return (
    <div className="p-6 rounded-md bg-background border space-y-4" data-testid={testId}>
      <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center text-primary">
        {icon}
      </div>
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </div>
  );
}
