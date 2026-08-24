import { useLocation } from "wouter";
import { ArrowLeft, Mail } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";

// ─── Shared layout ───────────────────────────────────────────────────────────

function LegalPageLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("/");
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Header */}
      <header
        className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border/40 shrink-0"
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingInlineStart: "env(safe-area-inset-left, 0px)",
          paddingInlineEnd: "env(safe-area-inset-right, 0px)",
        }}
      >
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={goBack}
            className="flex h-11 w-11 items-center justify-center -ms-2 rounded-full hover:bg-muted transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5 text-muted-foreground rtl:rotate-180" />
          </button>
          <LulouFlowerIcon className="w-7 h-7 shrink-0" />
          <div className="min-w-0">
            <h1 className="font-serif text-base font-semibold text-foreground leading-tight truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-8 pb-16">
        {children}
      </main>

      {/* Footer */}
      <footer className="max-w-2xl mx-auto w-full px-4 py-6 border-t border-border/30 text-center">
        <p className="text-xs text-muted-foreground/50">
          Lulou Dating · Last updated June 2025
        </p>
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="font-serif text-lg font-semibold text-foreground mb-3 pb-2 border-b border-border/40">
        {title}
      </h2>
      <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 list-none">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-primary/50 shrink-0 mt-0.5">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function ContactBlock({ email }: { email: string }) {
  return (
    <div className="mt-10 rounded-2xl bg-primary/5 border border-primary/10 p-5 flex gap-3 items-start">
      <Mail className="w-5 h-5 text-primary shrink-0 mt-0.5" />
      <div>
        <p className="font-medium text-sm text-foreground mb-0.5">Questions?</p>
        <a
          href={`mailto:${email}`}
          className="text-sm text-primary underline underline-offset-2"
        >
          {email}
        </a>
      </div>
    </div>
  );
}

// ─── Privacy Policy ───────────────────────────────────────────────────────────

export function PrivacyPolicyPage() {
  return (
    <LegalPageLayout
      title="Privacy Policy"
      subtitle="Effective June 2025"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        Lulou Dating (&ldquo;Lulou&rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;) is committed to protecting your privacy. This
        policy explains what information we collect, how we use it, and your
        rights as a user.
      </p>

      <Section title="1. Information We Collect">
        <p><strong className="text-foreground">Profile data</strong> — when you create a profile you provide your
          first name, date of birth, gender, location (city/region), height (optional),
          photos, a short bio, personality signals, green flags, dating intent,
          and connection style.</p>
        <p><strong className="text-foreground">Account data</strong> — email address, password (hashed, never
          stored in plain text), and phone number if you choose to add one for
          account recovery.</p>
        <p><strong className="text-foreground">Usage data</strong> — timestamps of app opens, profile views,
          swipe interactions, and feature usage. We do not log message content
          for analytics purposes.</p>
        <p><strong className="text-foreground">Device data</strong> — browser type, operating system, and IP
          address for security and fraud prevention.</p>
      </Section>

      <Section title="2. Photos & Media">
        <p>Photos you upload are compressed and stored securely in our cloud
          infrastructure (Supabase Storage). Profile photos are visible to other
          members on the platform.</p>
        <BulletList items={[
          "We do not use your photos to train AI or machine-learning models.",
          "Photos are stored with access controls — only authenticated users on the platform can view them.",
          "You can remove photos at any time from your profile settings.",
          "Deleted photos are removed from storage within 30 days of account deletion.",
        ]} />
      </Section>

      <Section title="3. Messages & Calls">
        <p>Your conversations on Lulou are handled with privacy in mind:</p>
        <BulletList items={[
          "Message content is stored in our database solely to deliver messages to your match.",
          "Messages are not read by Lulou staff except where required to investigate a safety report.",
          "Voice and video calls are peer-to-peer (WebRTC). Call audio and video are never routed through or recorded by our servers.",
          "Call metadata (timestamps, duration, match ID) is retained for safety and dispute resolution.",
          "Our automated content filter scans outgoing messages for phone numbers, emails, and social media handles to enforce platform safety rules — this is the only automated content inspection.",
        ]} />
      </Section>

      <Section title="4. Payment Information">
        <p>Payments for Lulou subscriptions, Elevate boosts, and extras are
          processed by <strong className="text-foreground">Stripe</strong>, a PCI-DSS compliant payment processor.</p>
        <BulletList items={[
          "We do not store your full card number, CVV, or expiry date.",
          "Stripe provides us with a tokenised payment reference and transaction ID only.",
          "Subscription status and purchase history are stored to manage your benefits.",
          "You can manage or cancel your subscription at any time from your device's app store or via Settings.",
        ]} />
      </Section>

      <Section title="5. Location Data">
        <p>Lulou uses location to show you people within your preferred distance
          radius.</p>
        <BulletList items={[
          "We store your approximate location (city or region level) — not precise GPS coordinates.",
          "Location is never shared directly with other users; only a calculated distance (e.g. \"3 miles away\") is shown.",
          "You can update your location from your profile settings at any time.",
          "We do not track your location in the background.",
        ]} />
      </Section>

      <Section title="6. How We Use Your Information">
        <BulletList items={[
          "To match you with compatible people based on your preferences and location.",
          "To operate and personalise your experience on the platform.",
          "To deliver messages, facilitate calls, and power the connection progression system.",
          "To process payments and manage subscription benefits.",
          "To enforce our Community Guidelines and keep the platform safe.",
          "To send transactional emails (e.g. email verification, match notifications) — never marketing without your consent.",
          "To detect and prevent fraud, abuse, and security threats.",
        ]} />
        <p className="mt-2 font-medium text-foreground">We do not sell your personal data to third parties.</p>
      </Section>

      <Section title="7. Data Sharing">
        <p>We share limited data with the following categories of service providers
          under strict data processing agreements:</p>
        <BulletList items={[
          "Supabase — database, authentication, file storage, and real-time messaging infrastructure.",
          "Stripe — payment processing.",
          "Cloudflare TURN servers — for facilitating peer-to-peer call connectivity (IP addresses are used transiently during call setup only).",
        ]} />
        <p>We do not share data with advertisers, data brokers, or social media
          platforms.</p>
      </Section>

      <Section title="8. Data Retention">
        <BulletList items={[
          "Your account data is retained for as long as your account is active.",
          "When you delete your account, your personal data (profile, photos, messages) is permanently deleted within 30 days.",
          "Anonymised, aggregated analytics (no personally identifiable information) may be retained for platform improvement.",
          "Payment records are retained for up to 7 years as required by financial regulations.",
          "Safety-related records (e.g. reports, blocks) may be retained for up to 12 months after account deletion to prevent abuse.",
        ]} />
      </Section>

      <Section title="9. Account Deletion">
        <p>You can delete your account at any time from <strong className="text-foreground">Settings → Account → Delete
          Account</strong>. Upon deletion:</p>
        <BulletList items={[
          "Your profile is immediately removed from discovery.",
          "All personal data is scheduled for permanent deletion within 30 days.",
          "Active subscriptions are cancelled; no further charges will be made.",
          "Your matches will lose access to your conversation history.",
        ]} />
        <p>For detailed information see our <strong className="text-foreground">Data Deletion Policy</strong>.</p>
      </Section>

      <Section title="10. Your Rights">
        <p>Depending on where you live, you may have the following rights regarding
          your personal data:</p>
        <BulletList items={[
          "Access — request a copy of the data we hold about you (use Download My Data in Settings).",
          "Correction — request that inaccurate data be corrected.",
          "Deletion — request permanent deletion of your account and data.",
          "Portability — receive your data in a machine-readable format.",
          "Restriction — request that we limit how we process your data.",
          "Objection — object to certain types of processing.",
        ]} />
        <p>To exercise any right, contact us at <a href="mailto:privacy@lulou.dating" className="text-primary underline">privacy@lulou.dating</a>. We will respond within 30 days.</p>
      </Section>

      <Section title="11. Children's Privacy">
        <p>Lulou is strictly for users aged <strong className="text-foreground">18 and over</strong>. We do not
          knowingly collect personal data from anyone under 18. If we become
          aware that a minor has registered, we will delete the account
          immediately. Please report suspected underage users to{" "}
          <a href="mailto:safety@lulou.dating" className="text-primary underline">
            safety@lulou.dating
          </a>.</p>
      </Section>

      <Section title="12. Security">
        <p>We implement industry-standard security measures including:</p>
        <BulletList items={[
          "All data transmitted over HTTPS/TLS encryption.",
          "Passwords hashed with bcrypt (Supabase Auth).",
          "Database access restricted by Row Level Security (RLS) policies.",
          "Regular security reviews and dependency audits.",
        ]} />
      </Section>

      <Section title="13. Changes to This Policy">
        <p>We may update this Privacy Policy from time to time. When we make
          material changes, we will notify you in-app or by email. Continued use
          of Lulou after the effective date constitutes acceptance of the revised
          policy.</p>
      </Section>

      <ContactBlock email="privacy@lulou.dating" />
    </LegalPageLayout>
  );
}

// ─── Terms of Service ─────────────────────────────────────────────────────────

export function TermsOfServicePage() {
  return (
    <LegalPageLayout
      title="Terms of Service"
      subtitle="Effective June 2025"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the Lulou Dating
        platform (&ldquo;Lulou&rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;the Service&rdquo;). By creating an account
        you agree to these Terms in full.
      </p>

      <Section title="1. Acceptance of Terms">
        <p>By registering for or using Lulou, you confirm that you have read,
          understood, and agree to be bound by these Terms and our Privacy
          Policy. If you do not agree, you must not use the Service.</p>
      </Section>

      <Section title="2. Eligibility">
        <BulletList items={[
          "You must be at least 18 years of age to create an account.",
          "You must be legally permitted to use dating services in your jurisdiction.",
          "You may not create an account on behalf of another person.",
          "You may only hold one active account at a time.",
          "By registering, you warrant that all information you provide is truthful, accurate, and current.",
        ]} />
        <p>We reserve the right to request age verification at any time. Accounts
          that cannot be verified as 18+ will be suspended.</p>
      </Section>

      <Section title="3. Prohibited Conduct">
        <p>You agree not to use Lulou to:</p>
        <BulletList items={[
          "Harass, bully, intimidate, stalk, or threaten any person.",
          "Send unsolicited explicit, sexual, or offensive content.",
          "Impersonate any person or entity, or misrepresent your identity.",
          "Use the platform for commercial solicitation, advertising, or multi-level marketing.",
          "Share or solicit contact details (phone numbers, social media handles, emails) before the platform unlocks them through the connection progression.",
          "Distribute spam, malware, or phishing links.",
          "Scrape, crawl, or systematically collect data from the platform.",
          "Attempt to reverse-engineer, decompile, or hack any part of the Service.",
          "Engage in any illegal activity including fraud, money laundering, or sex work.",
          "Engage in romance scams, catfishing, or any form of deception.",
          "Post content involving minors in any romantic or sexual context.",
        ]} />
      </Section>

      <Section title="4. Content Ownership & Licence">
        <p>You retain full ownership of the content you upload (photos, bio, messages).</p>
        <p>By uploading content, you grant Lulou a non-exclusive, royalty-free,
          worldwide licence to:</p>
        <BulletList items={[
          "Display your profile photos and information to other members as part of the matching service.",
          "Store and transmit your messages to deliver them to your match.",
          "Use anonymised, aggregated content insights to improve the platform.",
        ]} />
        <p>This licence ends when you delete the relevant content or your account,
          subject to retention requirements in our Privacy Policy.</p>
      </Section>

      <Section title="5. Payment Terms">
        <p><strong className="text-foreground">Subscriptions</strong></p>
        <BulletList items={[
          "Lulou offers optional paid subscriptions (Lulou Membership) and one-time purchases (Elevate boosts, Extras).",
          "All prices are shown in USD and are inclusive of applicable taxes where required.",
          "Subscriptions auto-renew monthly unless cancelled before the renewal date.",
          "You can cancel your subscription at any time from Settings or your app store account.",
          "Cancellation takes effect at the end of the current billing period; no partial refunds are issued for unused subscription time.",
        ]} />
        <p><strong className="text-foreground">One-time purchases</strong></p>
        <BulletList items={[
          "Credits, boosts, and extras are non-refundable once activated or used.",
          "Unused credits are forfeited upon account deletion.",
          "Prices are subject to change with 30 days' notice.",
        ]} />
        <p><strong className="text-foreground">Refunds</strong></p>
        <p>We offer refunds in limited circumstances (e.g. technical failure
          preventing use of a purchased feature). Contact{" "}
          <a href="mailto:support@lulou.dating" className="text-primary underline">
            support@lulou.dating
          </a>{" "}within 14 days of purchase. Refunds are not available for change of
          mind.</p>
      </Section>

      <Section title="6. Moderation & Enforcement">
        <p>Lulou reserves the right to:</p>
        <BulletList items={[
          "Remove any content that violates these Terms or our Community Guidelines.",
          "Issue warnings, temporarily suspend, or permanently ban accounts for violations.",
          "Cooperate with law enforcement when legally required.",
          "Use automated tools and human review to detect policy violations.",
        ]} />
        <p>Our moderation decisions are final. You may appeal a suspension by
          emailing{" "}
          <a href="mailto:support@lulou.dating" className="text-primary underline">
            support@lulou.dating
          </a>. We will respond within 14 days.</p>
      </Section>

      <Section title="7. Termination">
        <p><strong className="text-foreground">By you:</strong> You may delete your account at any time from
          Settings → Account → Delete Account.</p>
        <p><strong className="text-foreground">By us:</strong> We may suspend or terminate your account without
          notice if you seriously or repeatedly violate these Terms. Upon
          termination:</p>
        <BulletList items={[
          "Your access to the Service ends immediately.",
          "Active subscriptions are cancelled with no refund for unused time.",
          "Your data is subject to our retention policy in the Privacy Policy.",
        ]} />
      </Section>

      <Section title="8. Disclaimers">
        <p>Lulou is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We do not guarantee:</p>
        <BulletList items={[
          "That you will find a match or romantic connection.",
          "Uninterrupted or error-free service.",
          "That other members are who they claim to be.",
        ]} />
        <p>You are solely responsible for your interactions with other members.
          Always meet in public and trust your instincts. See our Safe Dating
          Tips for guidance.</p>
      </Section>

      <Section title="9. Limitation of Liability">
        <p>To the fullest extent permitted by applicable law, Lulou and its
          officers, directors, and employees will not be liable for any indirect,
          incidental, special, consequential, or punitive damages arising out of
          your use of the Service. Our total liability to you for any claim will
          not exceed the amount you paid us in the 12 months preceding the
          claim.</p>
      </Section>

      <Section title="10. Governing Law">
        <p>These Terms are governed by the laws of England and Wales. Any disputes
          shall be subject to the exclusive jurisdiction of the courts of England
          and Wales, unless local mandatory consumer protection laws in your
          country provide otherwise.</p>
      </Section>

      <Section title="11. Changes to These Terms">
        <p>We may update these Terms at any time. We will notify you of material
          changes via in-app notification or email at least 14 days before the
          change takes effect. Continued use after that date constitutes
          acceptance.</p>
      </Section>

      <ContactBlock email="legal@lulou.dating" />
    </LegalPageLayout>
  );
}

// ─── Community Guidelines ─────────────────────────────────────────────────────

export function CommunityGuidelinesPage() {
  return (
    <LegalPageLayout
      title="Community Guidelines"
      subtitle="How we keep Lulou a respectful space"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        Lulou exists to help people form genuine connections. These guidelines
        define the behaviour we expect from every member. Violations may result
        in warnings, suspension, or permanent removal.
      </p>

      {[
        {
          num: "01",
          title: "Be Genuine",
          body: "Use your real name and real photos. Do not impersonate anyone, create fake profiles, or misrepresent yourself. Authentic connection starts with honesty.",
        },
        {
          num: "02",
          title: "Be Respectful",
          body: "Treat every member with dignity. Differences in background, belief, or lifestyle are not grounds for disrespect. A polite 'not interested' is always acceptable; cruelty never is.",
        },
        {
          num: "03",
          title: "No Harassment",
          body: "Repeated unwanted messages, threats, or pressure of any kind will result in immediate removal. If someone does not reply or says no, respect their decision.",
        },
        {
          num: "04",
          title: "No Hate Speech or Discrimination",
          body: "Content that attacks or dehumanises people based on race, ethnicity, nationality, religion, gender, sexual orientation, disability, or any other protected characteristic is strictly prohibited.",
        },
        {
          num: "05",
          title: "No Explicit or Harmful Content",
          body: "Do not share unsolicited explicit images, graphic violence, or content that sexualises, exploits, or endangers anyone — especially minors. Zero-tolerance violations result in permanent bans and may be reported to authorities.",
        },
        {
          num: "06",
          title: "No Spam or Commercial Activity",
          body: "Lulou is not a marketplace. Do not use the platform to promote businesses, recruit for schemes, solicit money, or engage in any commercial or political activity.",
        },
        {
          num: "07",
          title: "18+ Only",
          body: "You must be 18 or older to use Lulou. Any account we identify as belonging to a minor is deleted immediately. If you suspect a user is under 18, report them.",
        },
        {
          num: "08",
          title: "Report, Don't Retaliate",
          body: "If something feels wrong, use the in-app report feature. Do not engage, argue, or attempt to expose the person publicly. Our Safety team reviews every report.",
        },
      ].map((item) => (
        <div
          key={item.num}
          className="flex gap-4 p-4 rounded-xl bg-muted/40 mb-4"
        >
          <span className="font-serif text-2xl font-bold text-primary/30 shrink-0 leading-none mt-0.5 w-8 text-right">
            {item.num}
          </span>
          <div>
            <p className="font-medium text-sm text-foreground mb-1">{item.title}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{item.body}</p>
          </div>
        </div>
      ))}

      <Section title="Enforcement">
        <p>Violations of these guidelines may result in:</p>
        <BulletList items={[
          "A warning and required acknowledgement before continued use.",
          "Temporary suspension (1 day to 30 days).",
          "Permanent removal from the platform.",
          "Reporting to law enforcement for illegal activity.",
        ]} />
        <p>Our enforcement decisions are made by humans, not just automated
          systems. You may appeal any action by emailing{" "}
          <a href="mailto:support@lulou.dating" className="text-primary underline">
            support@lulou.dating
          </a>.</p>
      </Section>

      <ContactBlock email="safety@lulou.dating" />
    </LegalPageLayout>
  );
}

// ─── Safe Dating Tips ─────────────────────────────────────────────────────────

export function SafeDatingPage() {
  const tips = [
    {
      emoji: "📞",
      title: "Use the In-App Call First",
      body: "Complete the structured voice and video call steps before sharing your phone number. This helps you gauge chemistry safely before going further.",
    },
    {
      emoji: "🚩",
      title: "Know the Red Flags",
      body: "Be cautious if someone avoids calls, refuses to video chat, asks for money or gift cards, or wants to move off the platform immediately. These are common signs of scams.",
    },
    {
      emoji: "📍",
      title: "Meet in a Public Place",
      body: "For your first in-person meeting, always choose a busy, well-lit public location — a café, restaurant, or park. Never meet at your home or theirs on a first date.",
    },
    {
      emoji: "🚗",
      title: "Arrange Your Own Transport",
      body: "Drive yourself, use public transport, or book your own taxi. Having independent transport means you can leave whenever you choose.",
    },
    {
      emoji: "📱",
      title: "Tell Someone Your Plans",
      body: "Let a friend or family member know who you're meeting, where, and when you expect to be home. Share your live location with someone you trust.",
    },
    {
      emoji: "🍹",
      title: "Watch Your Drink",
      body: "Never leave your drink unattended and never accept a drink you didn't see poured. Trust your instincts — if something feels off, it's OK to leave.",
    },
    {
      emoji: "🚫",
      title: "Never Send Money",
      body: "No matter how convincing the story, never send money, gift cards, or cryptocurrency to someone you've met online. Romance scams are sadly common.",
    },
    {
      emoji: "🆘",
      title: "Emergency Contacts",
      body: "Know your local emergency number. In many countries: UK 999, US 911, EU 112. If you feel unsafe at any point, trust your gut and remove yourself from the situation.",
    },
  ];

  return (
    <LegalPageLayout
      title="Safe Dating Tips"
      subtitle="Your safety is our priority"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        Lulou is designed to help you form genuine connections safely. These tips
        will help you stay safe both online and when meeting in person.
      </p>

      <div className="space-y-4">
        {tips.map((tip) => (
          <div
            key={tip.title}
            className="flex gap-3 p-4 rounded-xl bg-muted/40"
          >
            <span className="text-2xl shrink-0 mt-0.5">{tip.emoji}</span>
            <div>
              <p className="font-medium text-sm text-foreground mb-0.5">{tip.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{tip.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 p-5 rounded-2xl bg-primary/5 border border-primary/10">
        <p className="text-sm font-medium text-foreground mb-1">Need to report a safety concern?</p>
        <p className="text-sm text-muted-foreground">
          Use the in-app report button on any profile or message, or email us at{" "}
          <a href="mailto:safety@lulou.dating" className="text-primary underline">
            safety@lulou.dating
          </a>. We take every report seriously.
        </p>
      </div>
    </LegalPageLayout>
  );
}

// ─── Data Deletion Policy ─────────────────────────────────────────────────────

export function DataDeletionPage() {
  return (
    <LegalPageLayout
      title="Data Deletion Policy"
      subtitle="Your right to be forgotten"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        You have the right to have your personal data deleted. This page explains
        how to request deletion, what is removed, and what limited data may be
        retained for legal or safety reasons.
      </p>

      <Section title="1. How to Delete Your Account">
        <p>Account deletion is self-service and takes only a few seconds:</p>
        <BulletList items={[
          "Open Lulou and go to Settings (bottom navigation).",
          "Scroll to Account and tap Delete Account.",
          "Confirm the deletion when prompted.",
        ]} />
        <p>Your account is deactivated immediately upon confirmation. Your profile
          is removed from discovery and other members can no longer see you.</p>
        <p>If you cannot access your account, email{" "}
          <a href="mailto:privacy@lulou.dating" className="text-primary underline">
            privacy@lulou.dating
          </a>{" "}with the subject line &ldquo;Data Deletion Request&rdquo; and we will process
          it within 30 days.</p>
      </Section>

      <Section title="2. What Data Is Permanently Deleted">
        <p>Within 30 days of account deletion, the following is permanently
          removed:</p>
        <BulletList items={[
          "Your name, date of birth, and all profile fields.",
          "Your profile photos (removed from storage).",
          "Your message history with all matches.",
          "Your match history and connection data.",
          "Your preferences, settings, and app activity logs.",
          "Your email address and hashed password.",
          "Your phone number (if provided).",
          "Your location data.",
          "Your payment method tokens (card tokens are deleted from Stripe).",
          "Push notification tokens.",
        ]} />
      </Section>

      <Section title="3. Data That May Be Retained">
        <p>We retain a limited subset of data after deletion, only where
          legally required or necessary for safety:</p>
        <BulletList items={[
          "Transaction records — purchase amounts, dates, and Stripe payment IDs are retained for up to 7 years as required by financial and tax regulations. These records contain no payment card data.",
          "Safety records — if your account was the subject of a safety report, limited records may be retained for up to 12 months to prevent ban evasion and protect other members.",
          "Anonymised analytics — aggregated, non-identifiable usage statistics (no personal data) may be retained indefinitely for platform improvement.",
          "Legal holds — if we are required by law to preserve data (e.g. a court order), we will comply and notify you where permitted.",
        ]} />
      </Section>

      <Section title="4. Retention Timeline">
        <div className="space-y-3">
          {[
            { label: "Profile & photos",      timeline: "Deleted within 30 days" },
            { label: "Messages",              timeline: "Deleted within 30 days" },
            { label: "App activity logs",     timeline: "Deleted within 30 days" },
            { label: "Payment records",       timeline: "Retained up to 7 years" },
            { label: "Safety/report records", timeline: "Retained up to 12 months" },
            { label: "Anonymised analytics",  timeline: "Retained (no personal data)" },
          ].map((row) => (
            <div
              key={row.label}
              className="flex justify-between items-center py-2.5 border-b border-border/30 last:border-0"
            >
              <span className="text-sm text-foreground font-medium">{row.label}</span>
              <span className="text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
                {row.timeline}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="5. Third-Party Data">
        <p>Deleting your Lulou account also cancels your subscription with us,
          but you may need to separately manage data held by third-party
          services:</p>
        <BulletList items={[
          "Stripe — to request deletion of your payment data directly from Stripe, visit stripe.com/privacy.",
          "Supabase — acts as our data processor; data deletion is handled through our instructions to them.",
          "App stores — if you purchased via the App Store or Google Play, contact Apple or Google to manage their records.",
        ]} />
      </Section>

      <Section title="6. Download Before You Delete">
        <p>Before deleting your account you can export a copy of your data:</p>
        <p>Go to <strong className="text-foreground">Settings → Download My Data</strong> to receive a JSON file
          containing your profile information, match list, and message history.</p>
      </Section>

      <ContactBlock email="privacy@lulou.dating" />
    </LegalPageLayout>
  );
}

// ─── Cookie & Tracking Policy ─────────────────────────────────────────────────

export function CookiePolicyPage() {
  return (
    <LegalPageLayout
      title="Cookie & Tracking Policy"
      subtitle="What we store and why"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        This policy explains how Lulou uses cookies, local storage, and similar
        technologies when you use our web app or website.
      </p>

      <Section title="1. What Are Cookies?">
        <p>Cookies are small text files stored on your device by your browser.
          Along with similar technologies like localStorage and sessionStorage,
          they allow web applications to remember your preferences and maintain
          your session between page visits.</p>
      </Section>

      <Section title="2. How We Use Cookies & Local Storage">
        <p><strong className="text-foreground">Strictly necessary (cannot be disabled)</strong></p>
        <BulletList items={[
          "Authentication tokens — your login session is maintained via a secure Supabase JWT stored in browser memory and secure cookies. Without this you would be logged out on every page load.",
          "Security tokens — CSRF protection and request signing.",
          "User preferences — your language, distance unit (miles/km), and notification settings are stored locally so they persist between sessions.",
        ]} />
        <p className="mt-3"><strong className="text-foreground">Performance & functionality (cannot be disabled)</strong></p>
        <BulletList items={[
          "Cached profile data — recently viewed profiles are held in memory to reduce load times.",
          "Media cache — profile photo URLs are cached by the browser's HTTP cache for fast image loading.",
          "App state — active tab, open conversations, and other UI state are held in sessionStorage.",
        ]} />
        <p className="mt-3"><strong className="text-foreground">Analytics (optional)</strong></p>
        <BulletList items={[
          "We use anonymised, aggregated analytics to understand how features are used and where improvements are needed.",
          "No individual user is tracked. No advertising profiles are created.",
          "We do not use Google Analytics, Meta Pixel, or any advertising network trackers.",
        ]} />
      </Section>

      <Section title="3. No Advertising Tracking">
        <p>Lulou does <strong className="text-foreground">not</strong>:</p>
        <BulletList items={[
          "Use advertising cookies or tracking pixels.",
          "Share your data with ad networks, data brokers, or social media platforms for targeting.",
          "Build or sell advertising profiles based on your activity.",
          "Use cross-site tracking technologies.",
        ]} />
        <p>The only third-party scripts loaded are those required to operate the
          service (Supabase auth, Stripe checkout).</p>
      </Section>

      <Section title="4. Stripe Payment Cookies">
        <p>When you initiate a payment, Stripe may set cookies for fraud
          prevention and checkout session management. These are governed by
          Stripe's own Privacy Policy at{" "}
          <a
            href="https://stripe.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            stripe.com/privacy
          </a>.</p>
      </Section>

      <Section title="5. Your Choices">
        <p>Because the cookies and storage we use are strictly necessary or
          functional, we cannot offer a granular cookie opt-out without breaking
          the app. However, you may:</p>
        <BulletList items={[
          "Clear all site data in your browser settings — this will log you out and reset preferences.",
          "Use your browser's private/incognito mode — session data will not persist after you close the tab.",
          "Review and manage Privacy Preferences in Settings for any optional data collection choices.",
        ]} />
      </Section>

      <Section title="6. Changes to This Policy">
        <p>We will update this policy if our use of cookies or tracking
          technologies changes materially. We will notify you in-app or by email
          before changes take effect.</p>
      </Section>

      <ContactBlock email="privacy@lulou.dating" />
    </LegalPageLayout>
  );
}

// ─── Subscription & Billing Terms ────────────────────────────────────────────

export function BillingTermsPage() {
  return (
    <LegalPageLayout
      title="Subscription & Billing Terms"
      subtitle="Lulou Membership, Elevate & Extras"
    >
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        These billing terms govern all paid products offered by Lulou Dating,
        including Lulou Membership, Elevate boosts, and Extras. By making a
        purchase you agree to these terms.
      </p>

      <Section title="1. Paid Products">
        <div className="space-y-4">
          {[
            {
              name: "Lulou Membership",
              price: "$19.99 / month",
              desc: "A recurring monthly subscription unlocking premium features. Auto-renews unless cancelled before the renewal date.",
            },
            {
              name: "Elevate Boost",
              price: "From $9.99",
              desc: "Increases your profile's visibility in Discovery for 30 minutes. Credits are purchased in packs and activated on demand.",
            },
            {
              name: "Super Elevate Boost",
              price: "$34.99 (pack)",
              desc: "Increased visibility for 60 minutes at maximum weighting. Credits are purchased in a dedicated pack.",
            },
            {
              name: "Extras",
              price: "From $2.99",
              desc: "One-time purchases including message extensions (5 extra messages, $4.99), an extra call ($4.99), video call unlock ($6.99), and undo close ($2.99).",
            },
          ].map((product) => (
            <div key={product.name} className="p-4 rounded-xl bg-muted/40">
              <div className="flex justify-between items-start mb-1">
                <p className="font-medium text-sm text-foreground">{product.name}</p>
                <span className="text-xs text-primary font-semibold ml-2 shrink-0">
                  {product.price}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{product.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="2. Billing & Payment Processing">
        <BulletList items={[
          "All payments are processed by Stripe, Inc., a PCI-DSS Level 1 certified payment processor.",
          "Prices are in USD. Local currency conversions are performed by your card issuer.",
          "Your card is charged at the time of purchase confirmation.",
          "Subscription renewals are charged automatically on your billing date each month.",
          "You will receive a payment confirmation email from Stripe for each transaction.",
        ]} />
      </Section>

      <Section title="3. Free Trials">
        <p>We do not currently offer free trials. All purchases take effect
          immediately upon payment.</p>
      </Section>

      <Section title="4. Cancellation">
        <p><strong className="text-foreground">Membership subscription:</strong></p>
        <BulletList items={[
          "Cancel at any time from Settings → Lulou Extras → Manage Subscription.",
          "Cancellation takes effect at the end of the current billing period.",
          "You retain membership benefits until the period ends.",
          "No further charges are made after cancellation.",
        ]} />
        <p><strong className="text-foreground">One-time purchases (Extras, Elevate):</strong></p>
        <BulletList items={[
          "Credits and one-time purchases cannot be cancelled once confirmed.",
        ]} />
      </Section>

      <Section title="5. Refund Policy">
        <p>We want you to be satisfied with your purchase. Our refund policy:</p>
        <BulletList items={[
          "Subscriptions — no refund for unused days within a billing period, except where required by applicable law.",
          "One-time purchases — no refunds once the item has been activated or used.",
          "Technical issues — if a purchase fails to activate due to a technical error on our part, we will refund or re-credit the purchase. Contact support within 14 days.",
          "EU/UK users — if you are based in the EU or UK, you may have statutory rights to a 14-day cooling-off period for digital services not yet started. Contact us at support@lulou.dating to exercise this right.",
        ]} />
        <p>To request a refund, email{" "}
          <a href="mailto:support@lulou.dating" className="text-primary underline">
            support@lulou.dating
          </a>{" "}with your order details.</p>
      </Section>

      <Section title="6. Credits & Expiry">
        <BulletList items={[
          "Elevate and Super Elevate credits do not expire while your account is active.",
          "Credits are forfeited if your account is deleted or permanently banned for a Terms violation.",
          "Credits are non-transferable and cannot be exchanged for cash.",
        ]} />
      </Section>

      <Section title="7. Price Changes">
        <p>We reserve the right to change our prices. We will notify you at least
          30 days in advance of any price change affecting your active
          subscription. Continuing to use the Service after the change takes
          effect constitutes acceptance of the new price.</p>
      </Section>

      <Section title="8. Failed Payments">
        <p>If a subscription renewal payment fails:</p>
        <BulletList items={[
          "Stripe will automatically retry the payment up to 3 times over 7 days.",
          "You will be notified by email of each failed attempt.",
          "If all retries fail, your subscription will be cancelled and membership benefits removed.",
          "You can re-subscribe at any time from Settings.",
        ]} />
      </Section>

      <Section title="9. Disputes & Chargebacks">
        <p>If you believe a charge is incorrect, please contact us at{" "}
          <a href="mailto:support@lulou.dating" className="text-primary underline">
            support@lulou.dating
          </a>{" "}before initiating a chargeback with your bank. We resolve most
          disputes within 5 business days. Fraudulent chargebacks may result in
          account suspension.</p>
      </Section>

      <ContactBlock email="support@lulou.dating" />
    </LegalPageLayout>
  );
}
