/**
 * Profile-value i18n helpers.
 *
 * Profile fields (signals, green flags, dating intent, connection style,
 * conversation starters, profile questions) are stored in the DB as their
 * English display strings.  These helpers translate them at render time using
 * the viewer's selected language — no DB migration required.
 *
 * Compatibility: any value NOT found in the table is returned unchanged, so
 * custom user-written values (customSignals, customGreenFlags, etc.) pass
 * through untouched.
 *
 * Usage:
 *   import { translateSignal, translateGreenFlag, … } from "@/lib/profile-i18n";
 *   const { language } = useLanguageContext();
 *   import { LANGUAGE_NAME_TO_CODE } from "@/lib/i18n";
 *   const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
 *
 *   {translateSignal("Creative", langCode)}         // "Créatif" in French
 *   {translateIntent("Meaningful Relationship", t)} // uses existing i18n.ts key
 */

// ---------------------------------------------------------------------------
// Internal lookup helper
// ---------------------------------------------------------------------------
function lookup(
  map: Record<string, Record<string, string>>,
  value: string,
  langCode: string,
): string {
  const entry = map[value];
  if (!entry) return value;
  return entry[langCode] ?? entry["en"] ?? value;
}

// ---------------------------------------------------------------------------
// Signals  (12 preset values, all 16 app languages)
// ---------------------------------------------------------------------------
const SIGNAL_MAP: Record<string, Record<string, string>> = {
  "Emotionally Available": {
    en: "Emotionally Available", es: "Emocionalmente disponible",
    fr: "Émotionnellement disponible", ar: "متاح عاطفياً",
    de: "Emotional verfügbar", pt: "Emocionalmente disponível",
    it: "Emotivamente disponibile", nl: "Emotioneel beschikbaar",
    pl: "Dostępny emocjonalnie", ru: "Эмоционально открытый",
    "zh-CN": "情感上开放", "zh-TW": "情感上開放",
    ja: "感情的に開かれている", ko: "감정적으로 개방적",
    hi: "भावनात्मक रूप से उपलब्ध", sw: "Wazi kihisia",
  },
  "Playful": {
    en: "Playful", es: "Juguetón", fr: "Joueur", ar: "مرح",
    de: "Verspielt", pt: "Brincalhão", it: "Giocoso", nl: "Speels",
    pl: "Wesoły", ru: "Игривый", "zh-CN": "活泼", "zh-TW": "活潑",
    ja: "遊び心がある", ko: "장난기 있는", hi: "चंचल", sw: "Mchezaji",
  },
  "Calm Communicator": {
    en: "Calm Communicator", es: "Comunicador tranquilo",
    fr: "Communicateur calme", ar: "متواصل هادئ",
    de: "Ruhige Persönlichkeit", pt: "Comunicador calmo",
    it: "Comunicatore calmo", nl: "Rustige communicator",
    pl: "Spokojny rozmówca", ru: "Спокойный собеседник",
    "zh-CN": "平静沟通者", "zh-TW": "平靜溝通者",
    ja: "穏やかな対話者", ko: "차분한 소통자",
    hi: "शांत संचारक", sw: "Mwasiliano wa amani",
  },
  "Affectionate": {
    en: "Affectionate", es: "Afectuoso", fr: "Affectueux", ar: "عاطفي",
    de: "Liebevoll", pt: "Carinhoso", it: "Affettuoso", nl: "Liefdevol",
    pl: "Czuły", ru: "Нежный", "zh-CN": "温情", "zh-TW": "溫情",
    ja: "愛情深い", ko: "다정한", hi: "स्नेहशील", sw: "Mpole",
  },
  "Growth Minded": {
    en: "Growth Minded", es: "Mentalidad de crecimiento",
    fr: "Orienté vers la croissance", ar: "يسعى للنمو",
    de: "Wachstumsorientiert", pt: "Orientado ao crescimento",
    it: "Orientato alla crescita", nl: "Groeigericht",
    pl: "Nastawiony na rozwój", ru: "Ориентированный на рост",
    "zh-CN": "成长导向", "zh-TW": "成長導向",
    ja: "成長志向", ko: "성장 지향적",
    hi: "विकास-उन्मुख", sw: "Mwenye nia ya kukua",
  },
  "Romantic": {
    en: "Romantic", es: "Romántico", fr: "Romantique", ar: "رومانسي",
    de: "Romantisch", pt: "Romântico", it: "Romantico", nl: "Romantisch",
    pl: "Romantyczny", ru: "Романтичный", "zh-CN": "浪漫", "zh-TW": "浪漫",
    ja: "ロマンチック", ko: "로맨틱한", hi: "रोमांटिक", sw: "Wa kimapenzi",
  },
  "Adventurous": {
    en: "Adventurous", es: "Aventurero", fr: "Aventureux", ar: "مغامر",
    de: "Abenteuerlustig", pt: "Aventureiro", it: "Avventuroso",
    nl: "Avontuurlijk", pl: "Poszukiwacz przygód",
    ru: "Любящий приключения", "zh-CN": "爱冒险", "zh-TW": "愛冒險",
    ja: "冒険好き", ko: "모험적인", hi: "साहसी", sw: "Mpendaji wa matukio",
  },
  "Thoughtful": {
    en: "Thoughtful", es: "Reflexivo", fr: "Attentionné", ar: "متأمل",
    de: "Nachdenklich", pt: "Atencioso", it: "Premuroso", nl: "Attent",
    pl: "Przemyślany", ru: "Вдумчивый", "zh-CN": "体贴", "zh-TW": "體貼",
    ja: "思いやりのある", ko: "사려 깊은", hi: "विचारशील", sw: "Mwenye busara",
  },
  "Witty": {
    en: "Witty", es: "Ingenioso", fr: "Spirituel", ar: "ذكي الحوار",
    de: "Witzig", pt: "Espirituoso", it: "Spiritoso", nl: "Gevat",
    pl: "Dowcipny", ru: "Остроумный", "zh-CN": "机智", "zh-TW": "機智",
    ja: "機知に富む", ko: "재치 있는", hi: "तेज-तर्रार", sw: "Mcheshi",
  },
  "Compassionate": {
    en: "Compassionate", es: "Compasivo", fr: "Compatissant", ar: "متعاطف",
    de: "Mitfühlend", pt: "Compassivo", it: "Compassionevole",
    nl: "Medelevend", pl: "Współczujący", ru: "Сострадательный",
    "zh-CN": "富有同情心", "zh-TW": "富有同情心",
    ja: "思いやりがある", ko: "공감 능력 있는", hi: "दयालु", sw: "Mwenye huruma",
  },
  "Creative": {
    en: "Creative", es: "Creativo", fr: "Créatif", ar: "مبدع",
    de: "Kreativ", pt: "Criativo", it: "Creativo", nl: "Creatief",
    pl: "Kreatywny", ru: "Творческий", "zh-CN": "有创造力", "zh-TW": "有創造力",
    ja: "クリエイティブ", ko: "창의적인", hi: "रचनात्मक", sw: "Mbunifu",
  },
  "Grounded": {
    en: "Grounded", es: "Equilibrado", fr: "Ancré", ar: "متزن",
    de: "Geerdet", pt: "Equilibrado", it: "Equilibrato", nl: "Nuchter",
    pl: "Stabilny", ru: "Уравновешенный", "zh-CN": "脚踏实地", "zh-TW": "腳踏實地",
    ja: "落ち着いた", ko: "안정적인", hi: "स्थिर", sw: "Imara",
  },
};

// ---------------------------------------------------------------------------
// Green Flags  (8 preset values, all 16 app languages)
// ---------------------------------------------------------------------------
const GREEN_FLAG_MAP: Record<string, Record<string, string>> = {
  "Communicates Clearly": {
    en: "Communicates Clearly", es: "Comunica con claridad",
    fr: "Communique clairement", ar: "يتواصل بوضوح",
    de: "Kommuniziert klar", pt: "Comunica claramente",
    it: "Comunica chiaramente", nl: "Communiceert duidelijk",
    pl: "Komunikuje się jasno", ru: "Ясно выражает мысли",
    "zh-CN": "清晰沟通", "zh-TW": "清晰溝通",
    ja: "明確にコミュニケートする", ko: "명확하게 소통하는",
    hi: "स्पष्ट संवाद", sw: "Anawasiliana wazi",
  },
  "Emotionally Consistent": {
    en: "Emotionally Consistent", es: "Emocionalmente consistente",
    fr: "Émotionnellement cohérent", ar: "متسق عاطفياً",
    de: "Emotional beständig", pt: "Emocionalmente consistente",
    it: "Emotivamente coerente", nl: "Emotioneel consistent",
    pl: "Emocjonalnie stabilny", ru: "Эмоционально стабильный",
    "zh-CN": "情感稳定", "zh-TW": "情感穩定",
    ja: "感情が安定している", ko: "감정적으로 일관된",
    hi: "भावनात्मक रूप से सुसंगत", sw: "Thabiti kihisia",
  },
  "Keeps Their Word": {
    en: "Keeps Their Word", es: "Cumple su palabra",
    fr: "Tient ses promesses", ar: "يفي بوعده",
    de: "Hält sein Wort", pt: "Cumpre a palavra",
    it: "Mantiene la parola", nl: "Houdt zijn woord",
    pl: "Dotrzymuje słowa", ru: "Держит слово",
    "zh-CN": "信守承诺", "zh-TW": "信守承諾",
    ja: "約束を守る", ko: "약속을 지키는",
    hi: "अपनी बात रखता है", sw: "Anatimiza ahadi",
  },
  "Kind & Caring": {
    en: "Kind & Caring", es: "Amable y atento",
    fr: "Gentil et attentionné", ar: "لطيف ومهتم",
    de: "Freundlich & fürsorglich", pt: "Gentil e atencioso",
    it: "Gentile e premuroso", nl: "Vriendelijk en zorgzaam",
    pl: "Miły i troskliwy", ru: "Добрый и заботливый",
    "zh-CN": "善良体贴", "zh-TW": "善良體貼",
    ja: "優しく思いやりがある", ko: "친절하고 배려 있는",
    hi: "दयालु और देखभाल करने वाला", sw: "Mpole na mwenye huruma",
  },
  "Great Listener": {
    en: "Great Listener", es: "Gran oyente",
    fr: "Excellent auditeur", ar: "مستمع جيد",
    de: "Guter Zuhörer", pt: "Ótimo ouvinte",
    it: "Grande ascoltatore", nl: "Goede luisteraar",
    pl: "Dobry słuchacz", ru: "Умеет слушать",
    "zh-CN": "善于倾听", "zh-TW": "善於傾聽",
    ja: "聞き上手", ko: "훌륭한 청취자",
    hi: "अच्छा श्रोता", sw: "Msikilizaji mzuri",
  },
  "Shows Up Fully": {
    en: "Shows Up Fully", es: "Se presenta plenamente",
    fr: "Est pleinement présent", ar: "يكون حاضراً بالكامل",
    de: "Voll dabei", pt: "Presente por completo",
    it: "Presente appieno", nl: "Volledig aanwezig",
    pl: "W pełni zaangażowany", ru: "Полностью присутствует",
    "zh-CN": "全身心投入", "zh-TW": "全身心投入",
    ja: "全力で関わる", ko: "완전히 함께하는",
    hi: "पूरी तरह उपस्थित", sw: "Hujitolea kikamilifu",
  },
  "Respects Boundaries": {
    en: "Respects Boundaries", es: "Respeta los límites",
    fr: "Respecte les limites", ar: "يحترم الحدود",
    de: "Respektiert Grenzen", pt: "Respeita limites",
    it: "Rispetta i limiti", nl: "Respecteert grenzen",
    pl: "Szanuje granice", ru: "Уважает границы",
    "zh-CN": "尊重边界", "zh-TW": "尊重界線",
    ja: "境界線を尊重する", ko: "경계를 존중하는",
    hi: "सीमाओं का सम्मान", sw: "Anaheshimu mipaka",
  },
  "Genuinely Curious": {
    en: "Genuinely Curious", es: "Genuinamente curioso",
    fr: "Genuinement curieux", ar: "فضولي حقيقي",
    de: "Aufrichtig neugierig", pt: "Genuinamente curioso",
    it: "Genuinamente curioso", nl: "Oprecht nieuwsgierig",
    pl: "Autentycznie ciekawy", ru: "Искренне любопытный",
    "zh-CN": "真心好奇", "zh-TW": "真心好奇",
    ja: "純粋に好奇心旺盛", ko: "진심으로 호기심 있는",
    hi: "वास्तव में जिज्ञासु", sw: "Mwenye udadisi wa kweli",
  },
};

// ---------------------------------------------------------------------------
// Dating Intent — map English stored value → existing i18n.ts TranslationKey
// (keys intent_meaningful / intent_intentional / intent_open_serious are
//  already translated in all 16 languages inside i18n.ts)
// ---------------------------------------------------------------------------
const INTENT_KEY: Record<string, string> = {
  // Current values
  "Committed Relationship": "intent_committed",
  "Dating with Purpose":    "intent_purpose",
  "Open but Serious":       "intent_open_serious",
  // Legacy values — backwards compat for profiles created before the rename
  "Meaningful Relationship": "intent_meaningful",
  "Intentional Dating":      "intent_intentional",
};

// ---------------------------------------------------------------------------
// Connection Style — same pattern, uses style_slow / style_steady / style_ready
// ---------------------------------------------------------------------------
const STYLE_KEY: Record<string, string> = {
  "Slow & Intentional":   "style_slow",
  "Steady with Momentum": "style_steady",
  "Ready to Meet Soon":   "style_ready",
};

// ---------------------------------------------------------------------------
// Conversation starter prompts
// (EN, ES, FR, AR, DE, PT — fallback to EN for remaining 10 languages)
// Stored items are "<prompt>... <user answer>"; only the prompt is translated.
// ---------------------------------------------------------------------------
const STARTER_PROMPT_MAP: Record<string, Record<string, string>> = {
  "The way to my heart is...": {
    en: "The way to my heart is...", es: "El camino a mi corazón es...",
    fr: "Le chemin vers mon cœur est...", ar: "الطريق إلى قلبي هو...",
    de: "Der Weg zu meinem Herzen ist...", pt: "O caminho para o meu coração é...",
  },
  "A perfect Sunday looks like...": {
    en: "A perfect Sunday looks like...", es: "Un domingo perfecto se ve...",
    fr: "Un dimanche parfait ressemble à...", ar: "الأحد المثالي يبدو...",
    de: "Ein perfekter Sonntag sieht so aus...", pt: "Um domingo perfeito parece...",
  },
  "I'm proudest of...": {
    en: "I'm proudest of...", es: "De lo que más me enorgullezco es...",
    fr: "Ce dont je suis le plus fier c'est...", ar: "أكثر ما أفتخر به...",
    de: "Am stolzesten bin ich auf...", pt: "Do que mais me orgulho é...",
  },
  "Something most people don't know about me...": {
    en: "Something most people don't know about me...",
    es: "Algo que la mayoría no sabe de mí...",
    fr: "Quelque chose que la plupart des gens ignorent sur moi...",
    ar: "شيء لا يعرفه كثيرون عني...",
    de: "Etwas, das die meisten nicht über mich wissen...",
    pt: "Algo que a maioria das pessoas não sabe sobre mim...",
  },
  "I light up when I talk about...": {
    en: "I light up when I talk about...", es: "Me ilumino cuando hablo de...",
    fr: "Je m'anime quand je parle de...", ar: "أضيء حين أتحدث عن...",
    de: "Ich leuchte auf, wenn ich über ... spreche...", pt: "Fico animado quando falo sobre...",
  },
  "My love language is...": {
    en: "My love language is...", es: "Mi lenguaje del amor es...",
    fr: "Mon langage de l'amour est...", ar: "لغة حبي هي...",
    de: "Meine Liebessprache ist...", pt: "Minha linguagem do amor é...",
  },
  "A spontaneous thing I've done recently...": {
    en: "A spontaneous thing I've done recently...",
    es: "Algo espontáneo que hice recientemente...",
    fr: "Quelque chose de spontané que j'ai fait récemment...",
    ar: "شيء عفوي فعلته مؤخراً...",
    de: "Etwas Spontanes, das ich kürzlich getan habe...",
    pt: "Uma coisa espontânea que fiz recentemente...",
  },
  "The soundtrack of my life would be...": {
    en: "The soundtrack of my life would be...",
    es: "La banda sonora de mi vida sería...",
    fr: "La bande-son de ma vie serait...", ar: "موسيقى حياتي ستكون...",
    de: "Der Soundtrack meines Lebens wäre...",
    pt: "A trilha sonora da minha vida seria...",
  },
  "I feel most alive when...": {
    en: "I feel most alive when...", es: "Me siento más vivo cuando...",
    fr: "Je me sens le plus vivant quand...", ar: "أشعر بأكبر قدر من الحيوية عندما...",
    de: "Ich fühle mich am lebendigsten, wenn...", pt: "Me sinto mais vivo quando...",
  },
  "My comfort food after a long day is...": {
    en: "My comfort food after a long day is...",
    es: "Mi comida reconfortante después de un día largo es...",
    fr: "Ma nourriture réconfortante après une longue journée est...",
    ar: "طعامي المريح بعد يوم طويل هو...",
    de: "Mein Seelenfutter nach einem langen Tag ist...",
    pt: "Minha comida de conforto depois de um longo dia é...",
  },
  "A place I keep coming back to...": {
    en: "A place I keep coming back to...", es: "Un lugar al que siempre vuelvo...",
    fr: "Un endroit où je reviens toujours...", ar: "مكان أعود إليه دائماً...",
    de: "Ein Ort, zu dem ich immer zurückkehre...", pt: "Um lugar a que continuo voltando...",
  },
  "The best advice I've ever received...": {
    en: "The best advice I've ever received...",
    es: "El mejor consejo que he recibido...",
    fr: "Le meilleur conseil que j'aie jamais reçu...",
    ar: "أفضل نصيحة تلقيتها...",
    de: "Der beste Rat, den ich je bekommen habe...",
    pt: "O melhor conselho que já recebi...",
  },
  "I knew I'd found my people when...": {
    en: "I knew I'd found my people when...",
    es: "Supe que había encontrado mi gente cuando...",
    fr: "J'ai su que j'avais trouvé ma tribu quand...",
    ar: "عرفت أنني وجدت عشيرتي عندما...",
    de: "Ich wusste, dass ich meine Leute gefunden hatte, als...",
    pt: "Soube que encontrei minha turma quando...",
  },
  "My idea of romance is...": {
    en: "My idea of romance is...", es: "Mi idea del romance es...",
    fr: "Ma vision du romantisme est...", ar: "تصوري للرومانسية هو...",
    de: "Meine Vorstellung von Romantik ist...", pt: "Minha ideia de romance é...",
  },
  "Something I could talk about for hours...": {
    en: "Something I could talk about for hours...",
    es: "Algo de lo que podría hablar durante horas...",
    fr: "Quelque chose dont je pourrais parler pendant des heures...",
    ar: "شيء يمكنني الحديث عنه لساعات...",
    de: "Etwas, worüber ich stundenlang reden könnte...",
    pt: "Algo sobre o que eu poderia falar por horas...",
  },
  "The last thing that genuinely surprised me...": {
    en: "The last thing that genuinely surprised me...",
    es: "Lo último que me sorprendió de verdad...",
    fr: "La dernière chose qui m'a vraiment surpris...",
    ar: "آخر شيء فاجأني حقاً...",
    de: "Das Letzte, was mich wirklich überrascht hat...",
    pt: "A última coisa que realmente me surpreendeu...",
  },
  "A tradition I'd love to start with someone...": {
    en: "A tradition I'd love to start with someone...",
    es: "Una tradición que me encantaría empezar con alguien...",
    fr: "Une tradition que j'aimerais commencer avec quelqu'un...",
    ar: "تقليد أود البدء به مع شخص ما...",
    de: "Eine Tradition, die ich gerne mit jemandem starten würde...",
    pt: "Uma tradição que eu adoraria começar com alguém...",
  },
  "I'm secretly really good at...": {
    en: "I'm secretly really good at...",
    es: "Soy sorprendentemente bueno en...",
    fr: "Je suis secrètement très doué en...", ar: "أنا سراً بارع في...",
    de: "Ich bin heimlich richtig gut in...", pt: "Sou secretamente muito bom em...",
  },
  "What makes me laugh the hardest...": {
    en: "What makes me laugh the hardest...", es: "Lo que más me hace reír...",
    fr: "Ce qui me fait le plus rire...", ar: "ما يضحكني أكثر شيء...",
    de: "Was mich am meisten zum Lachen bringt...", pt: "O que me faz rir mais...",
  },
  "The moment I felt most grateful...": {
    en: "The moment I felt most grateful...",
    es: "El momento en que me sentí más agradecido...",
    fr: "Le moment où je me suis senti le plus reconnaissant...",
    ar: "اللحظة التي شعرت فيها بأكبر قدر من الامتنان...",
    de: "Der Moment, in dem ich mich am dankbarsten fühlte...",
    pt: "O momento em que me senti mais grato...",
  },
};

// ---------------------------------------------------------------------------
// Profile Questions — 20 preset values
// (EN, ES, FR, AR — fallback to EN for remaining 12 languages)
// ---------------------------------------------------------------------------
const PROFILE_QUESTION_MAP: Record<string, Record<string, string>> = {
  "What's one thing you're learning right now?": {
    en: "What's one thing you're learning right now?",
    es: "¿Qué es algo que estás aprendiendo ahora?",
    fr: "Qu'est-ce que tu apprends en ce moment?",
    ar: "ما الشيء الذي تتعلمه الآن؟",
  },
  "What does a meaningful relationship look like to you?": {
    en: "What does a meaningful relationship look like to you?",
    es: "¿Cómo es una relación significativa para ti?",
    fr: "À quoi ressemble une relation significative pour toi?",
    ar: "كيف تبدو العلاقة ذات المعنى بالنسبة لك؟",
  },
  "What's a small thing that makes your day better?": {
    en: "What's a small thing that makes your day better?",
    es: "¿Qué pequeña cosa mejora tu día?",
    fr: "Quelle petite chose améliore ta journée?",
    ar: "ما الشيء الصغير الذي يحسّن يومك؟",
  },
  "How do you recharge after a long week?": {
    en: "How do you recharge after a long week?",
    es: "¿Cómo recargas energías después de una semana larga?",
    fr: "Comment tu te ressources après une longue semaine?",
    ar: "كيف تجدد طاقتك بعد أسبوع طويل؟",
  },
  "What's a goal you're working toward?": {
    en: "What's a goal you're working toward?",
    es: "¿Cuál es un objetivo en el que estás trabajando?",
    fr: "Vers quel objectif tu travailles?",
    ar: "ما هدف تعمل على تحقيقه؟",
  },
  "What kind of conversations do you enjoy most?": {
    en: "What kind of conversations do you enjoy most?",
    es: "¿Qué tipo de conversaciones disfrutas más?",
    fr: "Quel type de conversations apprécies-tu le plus?",
    ar: "ما نوع المحادثات التي تستمتع بها أكثر؟",
  },
  "What does trust look like to you in a relationship?": {
    en: "What does trust look like to you in a relationship?",
    es: "¿Cómo se ve la confianza para ti en una relación?",
    fr: "À quoi ressemble la confiance pour toi dans une relation?",
    ar: "كيف تبدو الثقة في العلاقة بالنسبة لك؟",
  },
  "What's a book, film, or song that changed your perspective?": {
    en: "What's a book, film, or song that changed your perspective?",
    es: "¿Qué libro, película o canción cambió tu perspectiva?",
    fr: "Quel livre, film ou chanson a changé ta vision des choses?",
    ar: "ما كتاب أو فيلم أو أغنية غيّرت نظرتك؟",
  },
  "What would your closest friend say is your best quality?": {
    en: "What would your closest friend say is your best quality?",
    es: "¿Qué diría tu mejor amigo que es tu mejor cualidad?",
    fr: "Que dirait ton meilleur ami de ta meilleure qualité?",
    ar: "ماذا سيقول صديقك المقرب عن أفضل صفاتك؟",
  },
  "How do you handle disagreements with someone you care about?": {
    en: "How do you handle disagreements with someone you care about?",
    es: "¿Cómo manejas los desacuerdos con alguien que te importa?",
    fr: "Comment tu gères les désaccords avec quelqu'un qui t'est cher?",
    ar: "كيف تتعامل مع الخلافات مع شخص تهتم به؟",
  },
  "What does your ideal weeknight look like?": {
    en: "What does your ideal weeknight look like?",
    es: "¿Cómo es tu noche de semana ideal?",
    fr: "À quoi ressemble ta soirée de semaine idéale?",
    ar: "كيف تبدو ليلتك المثالية في أيام الأسبوع؟",
  },
  "What's a value you'd never compromise on?": {
    en: "What's a value you'd never compromise on?",
    es: "¿Cuál es un valor en el que nunca comprometerías?",
    fr: "Quelle valeur tu ne compromettrais jamais?",
    ar: "ما القيمة التي لن تتنازل عنها أبداً؟",
  },
  "What are you most curious about right now?": {
    en: "What are you most curious about right now?",
    es: "¿Sobre qué tienes más curiosidad ahora mismo?",
    fr: "Sur quoi es-tu le plus curieux en ce moment?",
    ar: "ما الذي تشعر بأكبر قدر من الفضول تجاهه الآن؟",
  },
  "How do you show someone you care?": {
    en: "How do you show someone you care?",
    es: "¿Cómo le muestras a alguien que te importa?",
    fr: "Comment tu montres à quelqu'un qu'il t'est cher?",
    ar: "كيف تُظهر لشخص ما أنك تهتم به؟",
  },
  "What's an experience that shaped who you are today?": {
    en: "What's an experience that shaped who you are today?",
    es: "¿Qué experiencia te formó como la persona que eres hoy?",
    fr: "Quelle expérience t'a façonné tel que tu es aujourd'hui?",
    ar: "ما التجربة التي شكّلت شخصيتك اليوم؟",
  },
  "What does personal growth mean to you?": {
    en: "What does personal growth mean to you?",
    es: "¿Qué significa el crecimiento personal para ti?",
    fr: "Que signifie la croissance personnelle pour toi?",
    ar: "ماذا يعني النمو الشخصي بالنسبة لك؟",
  },
  "What kind of support do you value most from a partner?": {
    en: "What kind of support do you value most from a partner?",
    es: "¿Qué tipo de apoyo valoras más de una pareja?",
    fr: "Quel type de soutien apprécies-tu le plus chez un partenaire?",
    ar: "ما نوع الدعم الذي تقدّره أكثر من الشريك؟",
  },
  "What's something you want to do more of this year?": {
    en: "What's something you want to do more of this year?",
    es: "¿Qué es algo que quieres hacer más este año?",
    fr: "Qu'est-ce que tu veux faire davantage cette année?",
    ar: "ما الشيء الذي تريد أن تفعله أكثر هذا العام؟",
  },
  "What does being present with someone look like to you?": {
    en: "What does being present with someone look like to you?",
    es: "¿Qué significa estar presente con alguien para ti?",
    fr: "Qu'est-ce qu'être présent avec quelqu'un signifie pour toi?",
    ar: "كيف يبدو التواجد الكامل مع شخص ما بالنسبة لك؟",
  },
  "What's the bravest thing you've ever done?": {
    en: "What's the bravest thing you've ever done?",
    es: "¿Cuál es la cosa más valiente que hayas hecho?",
    fr: "Quelle est la chose la plus courageuse que tu aies faite?",
    ar: "ما أشجع شيء فعلته في حياتك؟",
  },
};

// ---------------------------------------------------------------------------
// Public translate functions
// ---------------------------------------------------------------------------

/** Translate a preset signal value. Custom signals fall through unchanged. */
export function translateSignal(value: string, langCode: string): string {
  return lookup(SIGNAL_MAP, value, langCode);
}

/** Translate a preset green flag value. Custom flags fall through unchanged. */
export function translateGreenFlag(value: string, langCode: string): string {
  return lookup(GREEN_FLAG_MAP, value, langCode);
}

/**
 * Translate a dating intent value.
 * Requires the `t` function from useLanguageContext because the keys
 * (intent_meaningful etc.) already exist in i18n.ts for all 16 languages.
 */
export function translateIntent(value: string, t: (key: any) => string): string {
  const key = INTENT_KEY[value];
  return key ? t(key) : value;
}

/**
 * Translate a connection style value.
 * Requires the `t` function from useLanguageContext.
 */
export function translateStyle(value: string, t: (key: any) => string): string {
  const key = STYLE_KEY[value];
  return key ? t(key) : value;
}

/**
 * Translate a stored conversation starter item.
 *
 * Stored format: "<prompt>... <user answer>"
 * Only the prompt portion is translated; the user's free-text answer is kept
 * as-is (it is personal content, not a UI label).
 *
 * Custom starters (not matching any preset prompt) are returned unchanged.
 */
export function translateStarterItem(stored: string, langCode: string): string {
  for (const prompt of Object.keys(STARTER_PROMPT_MAP)) {
    if (stored.startsWith(prompt)) {
      const answer = stored.slice(prompt.length);
      const translatedPrompt = lookup(STARTER_PROMPT_MAP, prompt, langCode);
      return translatedPrompt + answer;
    }
  }
  return stored;
}

/**
 * Translate a profile question string (from the preset PROFILE_QUESTIONS list).
 * Custom questions fall through unchanged.
 */
export function translateQuestion(value: string, langCode: string): string {
  return lookup(PROFILE_QUESTION_MAP, value, langCode);
}
