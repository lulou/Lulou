export interface DnaAnswer {
  label: string;
  weights: Partial<DnaDimensions>;
}

export interface DnaQuestion {
  id: string;
  prompt: string;
  context: string;
  answers: DnaAnswer[];
}

export interface DnaDimensions {
  seriousness: number;
  commDirectness: number;
  emotionalDepth: number;
  affectionStyle: number;
  socialEnergy: number;
  independence: number;
  conflictRepair: number;
  datingPace: number;
  planningStyle: number;
  futureAlignment: number;
  playfulness: number;
  commFrequency: number;
  ambitionPriority: number;
  availabilityScore: number;
  lifestyle: number;
}

export const DIMENSION_LABELS: Record<keyof DnaDimensions, string> = {
  seriousness:       "Relationship Intention",
  commDirectness:    "Communication Style",
  emotionalDepth:    "Emotional Openness",
  affectionStyle:    "Affection",
  socialEnergy:      "Social Energy",
  independence:      "Independence",
  conflictRepair:    "Conflict Resolution",
  datingPace:        "Dating Pace",
  planningStyle:     "Spontaneity vs Structure",
  futureAlignment:   "Future Goals",
  playfulness:       "Playfulness",
  commFrequency:     "Communication Frequency",
  ambitionPriority:  "What You Value",
  availabilityScore: "Availability",
  lifestyle:         "Lifestyle Pace",
};

export const DNA_QUESTIONS: DnaQuestion[] = [
  {
    id: "q01",
    prompt: "Someone you're dating becomes quieter than usual. What would you naturally do?",
    context: "This helps us understand how you communicate when something feels off.",
    answers: [
      { label: "Ask directly if something is wrong",              weights: { commDirectness: 90, conflictRepair: 80 } },
      { label: "Give them space and check in later",              weights: { commDirectness: 45, independence: 65 } },
      { label: "Try to lighten the mood",                        weights: { playfulness: 70, commDirectness: 35 } },
      { label: "Wait for them to bring it up",                   weights: { commDirectness: 15, independence: 55 } },
      { label: "Feel uncertain and become quieter too",          weights: { commDirectness: 10, emotionalDepth: 60 } },
    ],
  },
  {
    id: "q02",
    prompt: "You have one completely free Saturday with someone you're dating. Which sounds most appealing?",
    context: "This tells us about your energy and how you enjoy spending time with someone.",
    answers: [
      { label: "A spontaneous day out — no plan, just explore",  weights: { socialEnergy: 80, planningStyle: 15, datingPace: 70 } },
      { label: "A planned activity, then dinner",                weights: { socialEnergy: 60, planningStyle: 70, datingPace: 55 } },
      { label: "A quiet day at home together",                   weights: { socialEnergy: 25, planningStyle: 50, datingPace: 40 } },
      { label: "Time apart followed by an evening together",     weights: { independence: 75, socialEnergy: 45, datingPace: 45 } },
      { label: "Seeing friends together as a couple",            weights: { socialEnergy: 85, planningStyle: 55, datingPace: 60 } },
    ],
  },
  {
    id: "q03",
    prompt: "When you imagine your life in three years, which feels closest to what you want?",
    context: "Understanding your relationship timeline helps us introduce people with compatible intentions.",
    answers: [
      { label: "Committed relationship — building toward marriage or family", weights: { seriousness: 95, futureAlignment: 90 } },
      { label: "Committed relationship — no rush on the formal steps",        weights: { seriousness: 75, futureAlignment: 65 } },
      { label: "A meaningful connection, without necessarily defining labels", weights: { seriousness: 50, futureAlignment: 45 } },
      { label: "Open to anything — it depends on the right person",           weights: { seriousness: 45, futureAlignment: 50 } },
      { label: "Enjoying life and not focused on long-term plans yet",        weights: { seriousness: 20, futureAlignment: 20 } },
    ],
  },
  {
    id: "q04",
    prompt: "Your partner has had a genuinely rough day. What's your natural first response?",
    context: "How you show up for someone tells us about your affection style and emotional availability.",
    answers: [
      { label: "Offer physical comfort — hold them close",        weights: { affectionStyle: 90, emotionalDepth: 70 } },
      { label: "Do something practical to help",                  weights: { affectionStyle: 55, lifestyle: 60 } },
      { label: "Give them space but stay close by",               weights: { affectionStyle: 35, independence: 65 } },
      { label: "Talk it through with them",                       weights: { affectionStyle: 65, emotionalDepth: 85, commDirectness: 70 } },
      { label: "Plan something fun to lift their mood",           weights: { affectionStyle: 60, playfulness: 75 } },
    ],
  },
  {
    id: "q05",
    prompt: "You and someone you're dating disagree on something important. What do you usually do?",
    context: "How we handle disagreement shapes the health of a relationship more than almost anything else.",
    answers: [
      { label: "Address it calmly and directly, the same day",   weights: { conflictRepair: 90, commDirectness: 85 } },
      { label: "Take time to think, then come back to it",        weights: { conflictRepair: 70, commDirectness: 55 } },
      { label: "Look for a compromise straight away",             weights: { conflictRepair: 75, commDirectness: 65 } },
      { label: "Let it pass if it's not critical",                weights: { conflictRepair: 30, independence: 60 } },
      { label: "I find it hard to move past disagreement",        weights: { conflictRepair: 15, emotionalDepth: 65 } },
    ],
  },
  {
    id: "q06",
    prompt: "How quickly do you usually know if you're genuinely interested in someone?",
    context: "This helps us understand your natural dating pace and how you form connections.",
    answers: [
      { label: "Pretty quickly — a few good conversations",       weights: { datingPace: 85, commDirectness: 70 } },
      { label: "It takes a couple of weeks of real interaction",  weights: { datingPace: 55, emotionalDepth: 60 } },
      { label: "I need to spend time together in person first",   weights: { datingPace: 40, affectionStyle: 70 } },
      { label: "It varies completely based on the person",        weights: { datingPace: 50, planningStyle: 45 } },
      { label: "I tend to take a long time to open up",           weights: { datingPace: 20, independence: 65 } },
    ],
  },
  {
    id: "q07",
    prompt: "In your ideal relationship, how much time would you spend together versus apart?",
    context: "This reveals how you balance closeness and personal space.",
    answers: [
      { label: "Almost always together — we share everything",    weights: { independence: 10, socialEnergy: 75 } },
      { label: "Mostly together with some independent time",      weights: { independence: 30, socialEnergy: 60 } },
      { label: "A balanced mix — together and separate",          weights: { independence: 50, socialEnergy: 50 } },
      { label: "Mostly independent, coming together intentionally", weights: { independence: 72, socialEnergy: 40 } },
      { label: "Highly independent — deep connection, not constant", weights: { independence: 88, socialEnergy: 30 } },
    ],
  },
  {
    id: "q08",
    prompt: "When you first start talking to someone, your conversations tend to be...",
    context: "How you open up early on shapes the kind of connection that forms.",
    answers: [
      { label: "Deep and real — surface chat doesn't interest me",    weights: { emotionalDepth: 92, playfulness: 25 } },
      { label: "I start light and warm up to depth over time",       weights: { emotionalDepth: 55, playfulness: 55 } },
      { label: "I follow the other person's lead",                   weights: { emotionalDepth: 50, playfulness: 50 } },
      { label: "Playful and light — I need trust before going deep", weights: { playfulness: 80, emotionalDepth: 30 } },
      { label: "Surface-level until I've met them in person",        weights: { emotionalDepth: 20, datingPace: 35 } },
    ],
  },
  {
    id: "q09",
    prompt: "Your ideal date is...",
    context: "This tells us about your planning style and what makes you feel most comfortable.",
    answers: [
      { label: "Planned well in advance — I like knowing the plan",  weights: { planningStyle: 90, lifestyle: 70 } },
      { label: "Planned for the occasion but flexible on the day",   weights: { planningStyle: 68, lifestyle: 55 } },
      { label: "Half-planned, half-spontaneous",                     weights: { planningStyle: 50, lifestyle: 50 } },
      { label: "Completely spontaneous — let's see where it goes",   weights: { planningStyle: 12, socialEnergy: 75 } },
      { label: "I prefer the other person to suggest something",     weights: { planningStyle: 50, independence: 35 } },
    ],
  },
  {
    id: "q10",
    prompt: "Which is closest to your vision of the future?",
    context: "Shared future goals are one of the strongest foundations for lasting connection.",
    answers: [
      { label: "Family — children, a home, stability",             weights: { futureAlignment: 92, seriousness: 85 } },
      { label: "Partnership — shared life, open on children",      weights: { futureAlignment: 68, seriousness: 75 } },
      { label: "Adventure — travel, experiences, freedom",         weights: { futureAlignment: 25, lifestyle: 75 } },
      { label: "Career and purpose — professional growth is central", weights: { futureAlignment: 38, ambitionPriority: 82 } },
      { label: "Balance — I want it all, still working it out",    weights: { futureAlignment: 55, seriousness: 55 } },
    ],
  },
  {
    id: "q11",
    prompt: "When you're seeing someone, how often do you naturally want to be in touch?",
    context: "Communication rhythm has a big impact on whether two people feel connected.",
    answers: [
      { label: "Throughout the day — I like regular check-ins",    weights: { commFrequency: 92, affectionStyle: 70 } },
      { label: "A few times a day, less when life is busy",        weights: { commFrequency: 65, lifestyle: 55 } },
      { label: "Once a day — maybe more on good days",             weights: { commFrequency: 45, independence: 50 } },
      { label: "When I have something real to say",                weights: { commFrequency: 22, independence: 68 } },
      { label: "I prefer a call or voice note over texts",         weights: { commFrequency: 50, emotionalDepth: 65 } },
    ],
  },
  {
    id: "q12",
    prompt: "Honestly, which description fits you better in relationships?",
    context: "This helps us find someone whose emotional register matches yours.",
    answers: [
      { label: "I go deep — I want to really know someone",          weights: { emotionalDepth: 90, playfulness: 28 } },
      { label: "A mix — playful on the surface, meaningful underneath", weights: { emotionalDepth: 65, playfulness: 68 } },
      { label: "Mostly light and fun — intensity takes time",        weights: { playfulness: 85, emotionalDepth: 28 } },
      { label: "I bring both depending on chemistry",                weights: { emotionalDepth: 52, playfulness: 52 } },
      { label: "I adapt completely to the other person",             weights: { emotionalDepth: 50, playfulness: 50 } },
    ],
  },
  {
    id: "q13",
    prompt: "Which best describes your typical week?",
    context: "Lifestyle compatibility matters more than most people realise.",
    answers: [
      { label: "Busy and full — lots happening, I love it",          weights: { lifestyle: 88, socialEnergy: 75, ambitionPriority: 70 } },
      { label: "Productive with proper time carved out for rest",    weights: { lifestyle: 65, planningStyle: 70 } },
      { label: "Relaxed with some commitments",                      weights: { lifestyle: 38, planningStyle: 50 } },
      { label: "Spontaneous — genuinely different every week",       weights: { lifestyle: 50, planningStyle: 15 } },
      { label: "Mostly free and flexible right now",                 weights: { lifestyle: 22, availabilityScore: 80 } },
    ],
  },
  {
    id: "q14",
    prompt: "When it comes to time and energy for dating right now, you are...",
    context: "Availability alignment helps us introduce you to people at a similar life stage.",
    answers: [
      { label: "Actively looking and making real time for it",        weights: { availabilityScore: 92, datingPace: 75 } },
      { label: "Dating while managing other priorities",              weights: { availabilityScore: 65, lifestyle: 60 } },
      { label: "Open to something — not actively seeking",           weights: { availabilityScore: 42, seriousness: 45 } },
      { label: "Life is full but the right person would come first", weights: { availabilityScore: 58, seriousness: 70 } },
      { label: "Honestly not sure what my capacity is yet",          weights: { availabilityScore: 28, seriousness: 40 } },
    ],
  },
  {
    id: "q15",
    prompt: "In a partner, which quality matters most to you?",
    context: "Knowing what you value helps us find someone whose strengths match what you genuinely care about.",
    answers: [
      { label: "Driven — ambition, direction, clear goals",           weights: { ambitionPriority: 85, lifestyle: 72 } },
      { label: "Grounded — stable, present, emotionally secure",      weights: { ambitionPriority: 45, emotionalDepth: 70, conflictRepair: 70 } },
      { label: "Creative — curious, expressive, original",            weights: { ambitionPriority: 42, playfulness: 72 } },
      { label: "Kind — warmth and empathy above everything",          weights: { ambitionPriority: 38, affectionStyle: 78, emotionalDepth: 72 } },
      { label: "Adventurous — someone who lives life fully",          weights: { ambitionPriority: 52, socialEnergy: 78, planningStyle: 20 } },
    ],
  },
];
