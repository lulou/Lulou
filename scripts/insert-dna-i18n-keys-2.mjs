/**
 * Inserts DNA/spin-room keys into zh-CN, zh-TW, ja, ko, hi, sw blocks.
 * These blocks close with `},` (no leading spaces) unlike the earlier blocks.
 * Run after insert-dna-i18n-keys.mjs.
 */
import { readFileSync, writeFileSync } from "fs";

const FILE = "client/src/lib/i18n.ts";
let src = readFileSync(FILE, "utf8");

const KEYS = {
  "zh-CN": `
    dna_intro_title:              "连接 DNA",
    dna_intro_subtitle:           "15 个简短问题，了解您如何建立联系——不仅仅是外貌。",
    dna_intro_what_this_does:     "这能做什么",
    dna_intro_bullet_1:           "将您与以同样方式联系的人匹配",
    dna_intro_bullet_2:           "帮助我们解释为什么介绍这两个人",
    dna_intro_bullet_3:           "随着 Lulou 从真实互动中学习不断改进",
    dna_intro_privacy:            "您的答案是私密的。我们从不共享原始分数。",
    dna_intro_begin_btn:          "开始——约 3 分钟",
    dna_complete_title:           "您的连接 DNA 已就绪",
    dna_complete_subtitle:        "您的答案帮助 Lulou 了解您如何沟通、联系和建立信任。",
    dna_complete_signals_label:   "您最强的信号",
    dna_complete_how_lulou_uses:  "Lulou 如何使用您的 DNA",
    dna_complete_bullet_1:        "在发现中优先显示更兼容的配置文件",
    dna_complete_bullet_2:        "识别共同的价值观和沟通风格",
    dna_complete_bullet_3:        "随着时间的推移提高介绍质量",
    dna_complete_bullet_4:        "生成有意义的兼容原因",
    dna_complete_bullet_5:        "了解哪种连接类型最适合您",
    dna_complete_privacy:         "您的个人答案是私密的。其他人只能看到选定的信号。",
    dna_complete_building:        "正在构建您的个人资料…",
    dna_complete_cta:             "查看我的连接",
    dna_go_back:                  "返回",
    dna_next_question:            "下一个问题 →",
    dna_review_answers:           "查看答案 →",
    dna_error_try_again:          "请重试。",
    lulou_quote_1:                "一种可能。一个故事。",
    lulou_quote_2:                "有时，合适的人会意外出现。",
    lulou_quote_3:                "今晚从一声问候开始。",
    lulou_quote_4:                "有些介绍感觉不同。",
    lulou_quote_5:                "每段连接都从一个时刻开始。",
    lulou_quote_6:                "Lulou 今晚为您选择了某人。",
    spin_room_compat_fallback:    "仔细看看，看看对话会带来什么。",
    halo_get_more:                "获取更多 Halo",
    halo_pkg1_label:              "1 个 Halo",
    halo_pkg1_sub:                "今晚再一次连接",
    halo_pkg3_label:              "3 个 Halo",
    halo_pkg3_sub:                "今晚再三次机会",
    halo_pkg5_label:              "5 个 Halo",
    halo_pkg5_sub:                "今晚自由探索",
    checkout_starting:            "正在开始结账…",
    checkout_connecting:          "正在连接支付提供商。",
    checkout_failed:              "结账失败",`,

  "zh-TW": `
    dna_intro_title:              "連接 DNA",
    dna_intro_subtitle:           "15 個簡短問題，了解您如何建立連結——不只是外貌。",
    dna_intro_what_this_does:     "這能做什麼",
    dna_intro_bullet_1:           "將您與以相同方式連結的人配對",
    dna_intro_bullet_2:           "協助我們解釋為何介紹這兩個人",
    dna_intro_bullet_3:           "隨著 Lulou 從真實互動中學習持續改進",
    dna_intro_privacy:            "您的答案是私密的。我們從不分享原始分數。",
    dna_intro_begin_btn:          "開始——約 3 分鐘",
    dna_complete_title:           "您的連接 DNA 已就緒",
    dna_complete_subtitle:        "您的答案協助 Lulou 了解您如何溝通、連結和建立信任。",
    dna_complete_signals_label:   "您最強的訊號",
    dna_complete_how_lulou_uses:  "Lulou 如何使用您的 DNA",
    dna_complete_bullet_1:        "在探索中優先顯示更相容的個人資料",
    dna_complete_bullet_2:        "識別共同的價值觀和溝通風格",
    dna_complete_bullet_3:        "隨時間提高介紹品質",
    dna_complete_bullet_4:        "產生有意義的相容原因",
    dna_complete_bullet_5:        "了解哪種連結類型最適合您",
    dna_complete_privacy:         "您的個人答案是私密的。其他人只能看到選定的訊號。",
    dna_complete_building:        "正在建立您的個人資料…",
    dna_complete_cta:             "查看我的連結",
    dna_go_back:                  "返回",
    dna_next_question:            "下一個問題 →",
    dna_review_answers:           "查看答案 →",
    dna_error_try_again:          "請重試。",
    lulou_quote_1:                "一種可能。一個故事。",
    lulou_quote_2:                "有時，合適的人會意外出現。",
    lulou_quote_3:                "今晚從一聲問候開始。",
    lulou_quote_4:                "有些介紹感覺不同。",
    lulou_quote_5:                "每段連結都從一個時刻開始。",
    lulou_quote_6:                "Lulou 今晚為您選擇了某人。",
    spin_room_compat_fallback:    "仔細看看，看看對話會帶來什麼。",
    halo_get_more:                "獲取更多 Halo",
    halo_pkg1_label:              "1 個 Halo",
    halo_pkg1_sub:                "今晚再一次連結",
    halo_pkg3_label:              "3 個 Halo",
    halo_pkg3_sub:                "今晚再三次機會",
    halo_pkg5_label:              "5 個 Halo",
    halo_pkg5_sub:                "今晚自由探索",
    checkout_starting:            "正在開始結帳…",
    checkout_connecting:          "正在連接付款提供商。",
    checkout_failed:              "結帳失敗",`,

  ja: `
    dna_intro_title:              "コネクション DNA",
    dna_intro_subtitle:           "あなたのつながり方を理解するための15の簡単な質問。見た目だけではありません。",
    dna_intro_what_this_does:     "これは何をするか",
    dna_intro_bullet_1:           "あなたと同じようにつながる人とマッチングします",
    dna_intro_bullet_2:           "なぜ二人を紹介したかを説明するのに役立ちます",
    dna_intro_bullet_3:           "Lulou が実際のやり取りから学ぶにつれ、時間とともに向上します",
    dna_intro_privacy:            "回答は非公開です。生のスコアを共有することはありません。",
    dna_intro_begin_btn:          "始める — 約3分",
    dna_complete_title:           "あなたのコネクション DNA が完成しました",
    dna_complete_subtitle:        "あなたの回答は、コミュニケーション、つながり、信頼構築の方法を Lulou が理解するのに役立ちます。",
    dna_complete_signals_label:   "あなたの最も強いシグナル",
    dna_complete_how_lulou_uses:  "Lulou があなたの DNA を使う方法",
    dna_complete_bullet_1:        "Discover でより互換性の高いプロフィールを優先表示",
    dna_complete_bullet_2:        "共有された価値観とコミュニケーションスタイルを特定",
    dna_complete_bullet_3:        "時間とともに紹介の質を向上",
    dna_complete_bullet_4:        "意味のある相性の理由を生成",
    dna_complete_bullet_5:        "あなたに最適なつながりのタイプを学習",
    dna_complete_privacy:         "個別の回答は非公開です。他のメンバーは選択されたシグナルのみ見ることができます。",
    dna_complete_building:        "プロフィールを構築中…",
    dna_complete_cta:             "つながりを見る",
    dna_go_back:                  "戻る",
    dna_next_question:            "次の質問 →",
    dna_review_answers:           "回答を確認 →",
    dna_error_try_again:          "もう一度お試しください。",
    lulou_quote_1:                "ひとつの可能性。ひとつの物語。",
    lulou_quote_2:                "ときに、正しい人は予期せずやってくる。",
    lulou_quote_3:                "今夜はこんにちはから始まる。",
    lulou_quote_4:                "いくつかの出会いは特別に感じる。",
    lulou_quote_5:                "すべてのつながりはひとつの瞬間から始まる。",
    lulou_quote_6:                "Lulou が今夜あなたのために誰かを選びました。",
    spin_room_compat_fallback:    "もっとよく見て、会話がどこへ向かうか確かめてください。",
    halo_get_more:                "Halo をもっと手に入れる",
    halo_pkg1_label:              "Halo 1 個",
    halo_pkg1_sub:                "今夜もう一つのつながり",
    halo_pkg3_label:              "Halo 3 個",
    halo_pkg3_sub:                "今夜さらに三つのチャンス",
    halo_pkg5_label:              "Halo 5 個",
    halo_pkg5_sub:                "今夜自由に探索",
    checkout_starting:            "チェックアウトを開始中…",
    checkout_connecting:          "決済プロバイダーに接続中。",
    checkout_failed:              "チェックアウトに失敗しました",`,

  ko: `
    dna_intro_title:              "연결 DNA",
    dna_intro_subtitle:           "당신이 어떻게 연결하는지 이해하기 위한 15가지 간단한 질문 — 외모만이 아닙니다.",
    dna_intro_what_this_does:     "이게 하는 일",
    dna_intro_bullet_1:           "당신처럼 연결하는 사람들과 매칭합니다",
    dna_intro_bullet_2:           "두 사람을 소개한 이유를 설명하는 데 도움이 됩니다",
    dna_intro_bullet_3:           "Lulou가 실제 상호작용에서 배우면서 시간이 지남에 따라 개선됩니다",
    dna_intro_privacy:            "답변은 비공개입니다. 원시 점수를 공유하지 않습니다.",
    dna_intro_begin_btn:          "시작 — 약 3분",
    dna_complete_title:           "연결 DNA가 완성되었습니다",
    dna_complete_subtitle:        "답변을 통해 Lulou가 의사소통, 연결, 신뢰 구축 방식을 이해합니다.",
    dna_complete_signals_label:   "가장 강한 신호",
    dna_complete_how_lulou_uses:  "Lulou가 DNA를 사용하는 방법",
    dna_complete_bullet_1:        "더 호환되는 프로필을 발견에서 우선 표시",
    dna_complete_bullet_2:        "공유된 가치관과 소통 스타일 식별",
    dna_complete_bullet_3:        "시간이 지남에 따라 소개 품질 향상",
    dna_complete_bullet_4:        "의미 있는 호환성 이유 생성",
    dna_complete_bullet_5:        "당신에게 가장 잘 맞는 연결 유형 학습",
    dna_complete_privacy:         "개별 답변은 비공개입니다. 다른 회원은 선택된 신호만 볼 수 있습니다.",
    dna_complete_building:        "프로필을 구축 중…",
    dna_complete_cta:             "내 연결 보기",
    dna_go_back:                  "뒤로",
    dna_next_question:            "다음 질문 →",
    dna_review_answers:           "답변 검토 →",
    dna_error_try_again:          "다시 시도해 주세요.",
    lulou_quote_1:                "하나의 가능성. 하나의 이야기.",
    lulou_quote_2:                "때로는 올바른 사람이 예상치 못하게 옵니다.",
    lulou_quote_3:                "오늘 밤은 안녕으로 시작됩니다.",
    lulou_quote_4:                "어떤 소개는 다르게 느껴집니다.",
    lulou_quote_5:                "모든 연결은 한 순간에서 시작됩니다.",
    lulou_quote_6:                "Lulou가 오늘 밤 당신을 위해 누군가를 선택했습니다.",
    spin_room_compat_fallback:    "더 자세히 살펴보고 대화가 어디로 향하는지 보세요.",
    halo_get_more:                "더 많은 Halo 받기",
    halo_pkg1_label:              "Halo 1개",
    halo_pkg1_sub:                "오늘 밤 연결 하나 더",
    halo_pkg3_label:              "Halo 3개",
    halo_pkg3_sub:                "오늘 밤 기회 세 번 더",
    halo_pkg5_label:              "Halo 5개",
    halo_pkg5_sub:                "오늘 밤 자유롭게 탐색",
    checkout_starting:            "결제 시작 중…",
    checkout_connecting:          "결제 제공업체에 연결 중.",
    checkout_failed:              "결제 실패",`,

  hi: `
    dna_intro_title:              "कनेक्शन DNA",
    dna_intro_subtitle:           "यह समझने के लिए 15 त्वरित प्रश्न कि आप कैसे जुड़ते हैं — सिर्फ दिखावट नहीं।",
    dna_intro_what_this_does:     "यह क्या करता है",
    dna_intro_bullet_1:           "आपको उन लोगों से मिलाता है जो आपकी तरह जुड़ते हैं",
    dna_intro_bullet_2:           "हमें यह समझाने में मदद करता है कि हमने दो लोगों का परिचय क्यों कराया",
    dna_intro_bullet_3:           "समय के साथ बेहतर होता है जैसे Lulou वास्तविक बातचीत से सीखता है",
    dna_intro_privacy:            "आपके उत्तर निजी हैं। हम कभी भी कच्चे स्कोर साझा नहीं करते।",
    dna_intro_begin_btn:          "शुरू करें — लगभग 3 मिनट",
    dna_complete_title:           "आपका कनेक्शन DNA तैयार है",
    dna_complete_subtitle:        "आपके उत्तर Lulou को यह समझने में मदद करते हैं कि आप कैसे संवाद करते हैं और विश्वास बनाते हैं।",
    dna_complete_signals_label:   "आपके सबसे मजबूत संकेत",
    dna_complete_how_lulou_uses:  "Lulou आपके DNA का उपयोग कैसे करता है",
    dna_complete_bullet_1:        "Discover में अधिक संगत प्रोफाइल को प्राथमिकता देता है",
    dna_complete_bullet_2:        "साझा मूल्यों और संचार शैलियों की पहचान करता है",
    dna_complete_bullet_3:        "समय के साथ परिचय की गुणवत्ता में सुधार करता है",
    dna_complete_bullet_4:        "सार्थक संगतता कारण उत्पन्न करता है",
    dna_complete_bullet_5:        "सीखता है कि किस प्रकार का कनेक्शन आपके लिए सबसे अच्छा काम करता है",
    dna_complete_privacy:         "आपके व्यक्तिगत उत्तर निजी हैं। अन्य सदस्य केवल चुने हुए संकेत देखते हैं।",
    dna_complete_building:        "आपकी प्रोफाइल बनाई जा रही है…",
    dna_complete_cta:             "मेरे कनेक्शन देखें",
    dna_go_back:                  "वापस जाएं",
    dna_next_question:            "अगला प्रश्न →",
    dna_review_answers:           "उत्तर समीक्षा करें →",
    dna_error_try_again:          "कृपया पुनः प्रयास करें।",
    lulou_quote_1:                "एक संभावना। एक कहानी।",
    lulou_quote_2:                "कभी-कभी सही व्यक्ति अप्रत्याशित रूप से आता है।",
    lulou_quote_3:                "आज रात एक नमस्ते से शुरू होती है।",
    lulou_quote_4:                "कुछ परिचय अलग महसूस होते हैं।",
    lulou_quote_5:                "हर कनेक्शन एक पल से शुरू होता है।",
    lulou_quote_6:                "Lulou ने आज रात आपके लिए किसी को चुना।",
    spin_room_compat_fallback:    "करीब से देखें और देखें कि बातचीत कहाँ ले जाती है।",
    halo_get_more:                "और Halo प्राप्त करें",
    halo_pkg1_label:              "1 Halo",
    halo_pkg1_sub:                "आज रात एक और कनेक्शन",
    halo_pkg3_label:              "3 Halo",
    halo_pkg3_sub:                "आज रात तीन और मौके",
    halo_pkg5_label:              "5 Halo",
    halo_pkg5_sub:                "आज रात स्वतंत्र रूप से खोजें",
    checkout_starting:            "चेकआउट शुरू हो रहा है…",
    checkout_connecting:          "भुगतान प्रदाता से जुड़ रहे हैं।",
    checkout_failed:              "चेकआउट विफल",`,

  sw: `
    dna_intro_title:              "DNA ya Uhusiano",
    dna_intro_subtitle:           "Maswali 15 ya haraka kuelewa jinsi unavyounganika — si tu mwonekano wako.",
    dna_intro_what_this_does:     "Hii inafanya nini",
    dna_intro_bullet_1:           "Inakuunganisha na watu wanaounganika kama wewe",
    dna_intro_bullet_2:           "Inatusaidia kueleza kwa nini tuliwasilisha watu wawili",
    dna_intro_bullet_3:           "Inaboresha kadri Lulou inavyojifunza kutoka kwa mwingiliano wa kweli",
    dna_intro_privacy:            "Majibu yako ni ya siri. Hatushiriki alama ghafi kamwe.",
    dna_intro_begin_btn:          "Anza — karibu dakika 3",
    dna_complete_title:           "DNA yako ya Uhusiano iko tayari",
    dna_complete_subtitle:        "Majibu yako yanasaidia Lulou kuelewa jinsi unavyowasiliana na kujenga uaminifu.",
    dna_complete_signals_label:   "Ishara zako kali zaidi",
    dna_complete_how_lulou_uses:  "Jinsi Lulou inavyotumia DNA yako",
    dna_complete_bullet_1:        "Inapaisha wasifu unaofaa zaidi katika Gundua",
    dna_complete_bullet_2:        "Inabainisha maadili yanayoshirikiwa na mitindo ya mawasiliano",
    dna_complete_bullet_3:        "Inaboresha ubora wa utambulisho kwa wakati",
    dna_complete_bullet_4:        "Inazalisha sababu za uoanifu zenye maana",
    dna_complete_bullet_5:        "Inajifunza aina ya uhusiano unaofanya kazi vizuri kwako",
    dna_complete_privacy:         "Majibu yako binafsi ni ya siri. Wengine wanaona ishara zilizochaguliwa tu.",
    dna_complete_building:        "Kujenga wasifu wako…",
    dna_complete_cta:             "Ona miunganiko yangu",
    dna_go_back:                  "Rudi",
    dna_next_question:            "Swali lijalo →",
    dna_review_answers:           "Kagua majibu →",
    dna_error_try_again:          "Tafadhali jaribu tena.",
    lulou_quote_1:                "Uwezekano mmoja. Hadithi moja.",
    lulou_quote_2:                "Wakati mwingine mtu sahihi anakuja bila kutarajiwa.",
    lulou_quote_3:                "Usiku huu unaanza na salamu.",
    lulou_quote_4:                "Baadhi ya utambulisho unahisi tofauti.",
    lulou_quote_5:                "Kila miunganiko huanza na wakati.",
    lulou_quote_6:                "Lulou amechagua mtu kwa ajili yako usiku huu.",
    spin_room_compat_fallback:    "Angalia kwa makini zaidi na uone mazungumzo yanakwenda wapi.",
    halo_get_more:                "Pata Halo zaidi",
    halo_pkg1_label:              "Halo 1",
    halo_pkg1_sub:                "Miunganiko moja zaidi usiku huu",
    halo_pkg3_label:              "Halo 3",
    halo_pkg3_sub:                "Nafasi tatu zaidi usiku huu",
    halo_pkg5_label:              "Halo 5",
    halo_pkg5_sub:                "Chunguza kwa uhuru usiku huu",
    checkout_starting:            "Kuanza malipo…",
    checkout_connecting:          "Kuunganisha na mtoa malipo.",
    checkout_failed:              "Malipo yameshindwa",`,
};

// Find each language's start so we can locate its closing `},`
const LANG_MARKERS = {
  "zh-CN": '"zh-CN": {',
  "zh-TW": '"zh-TW": {',
  ja:      "  ja: {",
  ko:      "  ko: {",
  hi:      "  hi: {",
  sw:      "  sw: {",
};

const lines = src.split("\n");

const insertions = [];

for (const [lang, marker] of Object.entries(LANG_MARKERS)) {
  // Find the line with the block opening
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) { startIdx = i; break; }
  }
  if (startIdx === -1) { console.error(`Could not find block start for: ${lang}`); continue; }

  // Find the first `},` or `} as const;` line AFTER the start
  let closingIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "}," || l === "} as const;" || l === "};") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) { console.error(`Could not find closing for: ${lang}`); continue; }

  const snippet = KEYS[lang];
  if (!snippet) { console.error(`No keys for: ${lang}`); continue; }
  insertions.push({ lineIndex: closingIdx, text: snippet, lang });
  console.log(`${lang}: start=${startIdx+1}, closing=${closingIdx+1}`);
}

// Reverse order so later insertions don't shift earlier ones
insertions.sort((a, b) => b.lineIndex - a.lineIndex);

for (const { lineIndex, text, lang } of insertions) {
  const newLines = text.split("\n");
  lines.splice(lineIndex, 0, ...newLines);
  console.log(`Inserted ${newLines.length} lines before line ${lineIndex+1} for ${lang}`);
}

const result = lines.join("\n");
writeFileSync(FILE, result, "utf8");
console.log(`Done. Updated ${insertions.length} language blocks.`);
