// Clef Playground — demo scenarios and bundled sample media.
// All strings are bilingual: the state text is what the model evaluates, so it
// follows the UI language.

export type QuestionType = "noul" | "choice" | "score";
export type L10n = { zh: string; en: string };

export interface PresetQuestion {
  id: string;
  type: QuestionType;
  instructions: L10n;
  options?: Array<{ key: string; desc: L10n }>;
  levels?: L10n[];
}

export interface Preset {
  key: string;
  group: "tw" | "text";
  json?: boolean;
  /** Who uses this and what it replaces — shown as the "use case" callout */
  useCase?: L10n;
  /** Sample ids from SAMPLES that are attached automatically */
  samples?: string[];
  state: L10n;
  questions: PresetQuestion[];
}

export interface Sample {
  id: string;
  kind: "image" | "audio" | "video";
  url: string;
  mime: string;
  name: L10n;
  /** seconds, audio/video only */
  duration?: number;
  /** Provenance shown in the credits line */
  source: L10n;
}

const SAMPLE_DIR = "/clef-samples";
const COMMONS = (title: string, author: string, license: string): L10n => ({
  zh: `Wikimedia Commons「${title}」· ${author} · ${license}`,
  en: `Wikimedia Commons "${title}" · ${author} · ${license}`,
});
const SYNTH_AUDIO: L10n = { zh: "macOS 台灣國語語音合成（虛構劇本）", en: "Synthesized with macOS Taiwanese Mandarin TTS (fictional script)" };

export const SAMPLES: Sample[] = [
  { id: "scam-sms", kind: "image", url: `${SAMPLE_DIR}/scam-sms.png`, mime: "image/png", name: { zh: "詐騙簡訊截圖", en: "Scam SMS screenshot" }, source: { zh: "自製虛構截圖（品牌與網址皆為虛構）", en: "Fictional screenshot (brand and URL are made up)" } },
  { id: "invoice", kind: "image", url: `${SAMPLE_DIR}/invoice.jpg`, mime: "image/jpeg", name: { zh: "電子發票證明聯", en: "E-invoice receipt" }, source: COMMONS("7-Eleven Songtie Store e-invoice NJ05691170", "Solomon203", "CC BY-SA 4.0") },
  { id: "rider", kind: "image", url: `${SAMPLE_DIR}/rider.jpg`, mime: "image/jpeg", name: { zh: "路邊外送機車", en: "Delivery scooter on the street" }, source: COMMONS("Aeon Elite 250 with Uber Eats box in front of E.SUN Financial Building 20200911", "玄史生", "CC0") },
  { id: "stall", kind: "image", url: `${SAMPLE_DIR}/stall.jpg`, mime: "image/jpeg", name: { zh: "夜市小吃攤", en: "Night market food stall" }, source: COMMONS("DSCF1206 A nighttime street food stall…", "PattayaPatrol", "CC BY-SA 4.0") },
  { id: "customer-call", kind: "audio", url: `${SAMPLE_DIR}/customer-call.mp3`, mime: "audio/mpeg", duration: 31.8, name: { zh: "客服來電：包裹延誤客訴", en: "Support call: delayed parcel complaint" }, source: SYNTH_AUDIO },
  { id: "scam-call", kind: "audio", url: `${SAMPLE_DIR}/scam-call.mp3`, mime: "audio/mpeg", duration: 35.8, name: { zh: "來電：假冒檢察官", en: "Call: fake prosecutor" }, source: SYNTH_AUDIO },
  { id: "traffic", kind: "video", url: `${SAMPLE_DIR}/traffic.mp4`, mime: "video/mp4", duration: 13.8, name: { zh: "台北橋機車瀑布", en: "Taipei Bridge scooter wave" }, source: COMMONS("June 2023 motorcycle waterfall on Taipei Bridge by rush hour commuters 06", "Tze Chiang Hao", "CC BY-SA 4.0（已轉檔縮小）") },
  { id: "bus", kind: "video", url: `${SAMPLE_DIR}/bus.mp4`, mime: "video/mp4", duration: 20.2, name: { zh: "新北公車多語播報", en: "New Taipei bus multilingual announcement" }, source: COMMONS("202407 Multilingual broadcasting on a bus in New Taipei City", "Jonashtand", "CC BY-SA 4.0（已轉檔縮小）") },
];

// ── tiny builders to keep the scenarios readable ──
const L = (zh: string, en: string): L10n => ({ zh, en });
const yn = (id: string, zh: string, en: string): PresetQuestion => ({ id, type: "noul", instructions: L(zh, en) });
const pick = (id: string, zh: string, en: string, opts: Array<[string, string, string]>): PresetQuestion => ({
  id, type: "choice", instructions: L(zh, en), options: opts.map(([key, z, e]) => ({ key, desc: L(z, e) })),
});
const rate = (id: string, zh: string, en: string, levels: Array<[string, string]>): PresetQuestion => ({
  id, type: "score", instructions: L(zh, en), levels: levels.map(([z, e]) => L(z, e)),
});

export const PRESETS: Preset[] = [
  // ── Taiwan scenarios (audio / image / video) ──
  {
    key: "customerCall", group: "tw", samples: ["customer-call"],
    useCase: L(
      "電商／物流客服中心：來電錄音直接判斷客戶是否憤怒、該轉哪個單位、有多急，不必先轉逐字稿再分類，主管可即時掌握客訴升級風險。",
      "E-commerce / logistics contact centers: judge anger, routing, and urgency straight from the call audio — no transcription step — so supervisors see escalation risk in real time."
    ),
    state: L("這是一通客戶打來的客服電話錄音，請依據通話內容判斷。", "This is a recording of a customer calling support. Judge it from the call."),
    questions: [
      yn("angry", "客戶是否情緒憤怒？", "Is the customer angry?"),
      yn("threat", "客戶是否威脅要向消保官投訴或退貨？", "Does the customer threaten a consumer complaint or a return?"),
      pick("dept", "應轉給哪個單位？", "Which team should take this?", [
        ["logistics", "物流配送問題", "Logistics and delivery"], ["billing", "付款與退款", "Payments and refunds"],
        ["product", "商品品質", "Product quality"], ["escalation", "客訴升級主管處理", "Escalate to a supervisor"],
      ]),
      rate("urgency", "處理的急迫程度", "How urgent is this?", [["不急", "Not urgent"], ["一般", "Normal"], ["急", "Urgent"], ["非常急", "Critical"]]),
    ],
  },
  {
    key: "scamCall", group: "tw", samples: ["scam-call"],
    useCase: L(
      "電信業者／銀行反詐騙：假冒檢警是台灣常見的詐騙手法。通話錄音（或片段）直接判斷是否詐騙與手法，決定要不要即時警示用戶、通報 165。",
      "Telcos and banks fighting fraud: fake-prosecutor calls are a common scam in Taiwan. Classify a call (or a clip) and decide whether to warn the user or report to the 165 hotline."
    ),
    state: L("這是一通來電錄音，請判斷是否為詐騙電話。", "This is a recording of an incoming call. Decide whether it is a scam."),
    questions: [
      yn("scam", "這通電話是詐騙嗎？", "Is this call a scam?"),
      pick("type", "詐騙手法類型？", "Which scam type?", [
        ["fake_prosecutor", "假冒檢警", "Fake police / prosecutor"], ["fake_invest", "假投資", "Fake investment"],
        ["fake_service", "假冒客服解除分期", "Fake customer service"], ["none", "非詐騙", "Not a scam"],
      ]),
      pick("action", "應如何處理？", "What should happen?", [
        ["allow", "放行", "Allow"], ["warn", "即時簡訊警示用戶", "Send the user a warning SMS"], ["block", "攔截並通報 165 反詐騙專線", "Block and report to the 165 hotline"],
      ]),
    ],
  },
  {
    key: "scamSms", group: "tw", samples: ["scam-sms"],
    useCase: L(
      "簡訊閘道／行動電話業者：用戶回報的簡訊截圖，直接判斷是否為釣魚簡訊，不需要另外做 OCR 再分類。",
      "SMS gateways and mobile carriers: classify user-reported SMS screenshots as phishing directly — no separate OCR step."
    ),
    state: L("請根據附上的簡訊截圖判斷。", "Judge based on the attached SMS screenshot."),
    questions: [
      yn("phish", "這則簡訊是詐騙／釣魚簡訊嗎？", "Is this SMS a scam or phishing message?"),
      yn("asks_card", "簡訊是否要求輸入信用卡資料？", "Does it ask for credit card details?"),
      pick("action", "應如何處理？", "What should happen?", [["deliver", "正常顯示", "Deliver normally"], ["warn", "標示可疑警告", "Show a suspicious-message warning"], ["block", "直接攔截", "Block"]]),
    ],
  },
  {
    key: "invoice", group: "tw", samples: ["invoice"],
    useCase: L(
      "企業費用核銷：員工拍下電子發票證明聯，自動判斷是否為有效憑證、資訊是否完整，減少會計退件與來回補件。",
      "Expense reporting: employees snap an e-invoice; check whether it is a valid, complete receipt before accounting rejects it."
    ),
    state: L("請根據附上的發票照片判斷。", "Judge based on the attached invoice photo."),
    questions: [
      yn("is_receipt", "這是一張發票或收據嗎？", "Is this an invoice or receipt?"),
      yn("store", "照片中看得到店家名稱嗎？", "Is the store name visible?"),
      rate("claimable", "作為公司報帳憑證的完整度", "How complete is it as an expense receipt?", [["無法使用", "Unusable"], ["缺少很多資訊", "Missing a lot"], ["大致完整", "Mostly complete"], ["完整可報帳", "Complete"]]),
    ],
  },
  {
    key: "rider", group: "tw", samples: ["rider"],
    useCase: L(
      "外送平台／商圈管理／保險：路邊巡檢照片自動辨識場景（有無外送員、機車、地點類型），不必為每個情境訓練專用模型。",
      "Delivery platforms, district management, insurers: classify street photos (couriers, scooters, location type) without training a model per scenario."
    ),
    state: L("請根據附上的街景照片判斷。", "Judge based on the attached street photo."),
    questions: [
      yn("rider", "照片中有外送平台的外送員或外送箱嗎？", "Is there a delivery courier or delivery box?"),
      yn("scooter", "照片中有機車嗎？", "Is there a scooter?"),
      pick("place", "拍攝地點類型？", "What kind of place is this?", [
        ["street", "一般街道", "Ordinary street"], ["store", "商店門口", "Storefront"], ["bank", "金融機構／辦公大樓前", "In front of a bank / office building"], ["other", "其他", "Other"],
      ]),
    ],
  },
  {
    key: "stall", group: "tw", samples: ["stall"],
    useCase: L(
      "夜市／商圈管理：巡檢照片判斷是否為餐飲攤位、人潮擁擠程度與時段，輔助人流管理與稽查排程。",
      "Night market / district management: tell food stalls apart, gauge crowding and time of day to plan crowd management and inspections."
    ),
    state: L("請根據附上的照片判斷。", "Judge based on the attached photo."),
    questions: [
      yn("food", "這是賣吃的攤位嗎？", "Is this a food stall?"),
      rate("busy", "人潮擁擠程度", "How crowded is it?", [["空無一人", "Empty"], ["稀少", "Sparse"], ["普通", "Moderate"], ["擁擠", "Crowded"]]),
      pick("time", "拍攝時段？", "Time of day?", [["day", "白天", "Daytime"], ["night", "夜晚", "Night"]]),
    ],
  },
  {
    key: "traffic", group: "tw", samples: ["traffic"],
    useCase: L(
      "智慧交通／市政：路口攝影機影片判斷機車流量與壅塞程度，一個模型涵蓋多種路口，不必為每支鏡頭訓練偵測模型。",
      "Smart traffic / municipalities: read scooter volume and congestion from intersection video with one model instead of one detector per camera."
    ),
    state: L("這是一段路口交通影片。", "This is a clip of traffic at an intersection."),
    questions: [
      yn("moto", "畫面中是否有大量機車？", "Are there large numbers of scooters?"),
      rate("congest", "車流壅塞程度", "How congested is the traffic?", [["順暢", "Free-flowing"], ["普通", "Moderate"], ["擁擠", "Heavy"], ["嚴重壅塞", "Gridlocked"]]),
      pick("time", "拍攝時段？", "Time of day?", [["day", "白天", "Daytime"], ["dusk", "傍晚", "Dusk"], ["night", "夜晚", "Night"]]),
    ],
  },
  {
    key: "bus", group: "tw", samples: ["bus"],
    useCase: L(
      "大眾運輸稽核：行車影片連同廣播音軌一起判斷，是否有報站、使用什麼語言，檢查多語播報是否落實，不用另外做語音轉文字。",
      "Public transit auditing: judge video and its audio track together — whether stops are announced and in which language — without a speech-to-text step."
    ),
    state: L("這是一段公車車內影片，含車內廣播。", "This is an in-bus video with the on-board announcement."),
    questions: [
      yn("bus", "畫面是在公車上嗎？", "Is this inside a bus?"),
      yn("announce", "廣播是否有播報站名或乘車資訊？", "Does the announcement name a stop or give ride information?"),
      pick("lang", "廣播主要使用的語言？", "Main language of the announcement?", [["mandarin", "國語", "Mandarin"], ["hokkien", "台語", "Taiwanese Hokkien"], ["hakka", "客語", "Hakka"], ["english", "英語", "English"]]),
    ],
  },

  // ── Text-only scenarios ──
  {
    key: "triage", group: "text",
    state: L(
      "過去一小時所有客戶在結帳頁面都失敗，畫面顯示 502 錯誤。我們的雙 11 活動今晚就要上線，請立刻處理！",
      "Checkout has been failing for every customer for the last hour with a 502 error. Our Black Friday campaign goes live tonight, please fix this now!"
    ),
    questions: [
      yn("urgent", "這個支援請求緊急嗎？", "Is this support request urgent?"),
      pick("team", "應該由哪個團隊處理？", "Which team should handle this request?", [["billing", "付款、發票與退款", "Payments, invoices, and refunds"], ["technical", "服務中斷、錯誤與設定", "Outages, errors, and configuration"], ["sales", "方案與升級", "Plans and upgrades"]]),
      rate("severity", "對客戶的影響有多嚴重？", "How severe is the customer impact?", [["無影響", "No impact"], ["輕微", "Minor"], ["嚴重", "Major"], ["重大", "Critical"]]),
    ],
  },
  {
    key: "phishing", group: "text",
    state: L(
      "寄件者：security@paypa1-support.com\n主旨：【緊急】您的帳戶已被暫停\n\n親愛的用戶，我們偵測到異常登入，您的帳戶將在 24 小時內永久停用。請立即點擊以下連結驗證身分並輸入信用卡資料：http://paypa1-verify.xyz/login",
      "From: security@paypa1-support.com\nSubject: [URGENT] Your account has been suspended\n\nDear user, we detected unusual sign-in activity and your account will be permanently disabled within 24 hours. Click the link below immediately to verify your identity and enter your credit card details: http://paypa1-verify.xyz/login"
    ),
    questions: [
      yn("phishing", "這封郵件是釣魚郵件嗎？", "Is this email a phishing attempt?"),
      pick("tactic", "主要使用的社交工程手法是什麼？", "What is the primary social-engineering tactic?", [["urgency", "製造急迫感", "Creating urgency"], ["impersonation", "冒充品牌或機構", "Brand or authority impersonation"], ["reward", "利誘獎賞", "Promise of a reward"], ["none", "無明顯手法", "No clear tactic"]]),
      pick("action", "郵件閘道應採取什麼動作？", "What should the email gateway do?", [["deliver", "正常投遞", "Deliver normally"], ["warn", "加上警告標籤後投遞", "Deliver with a warning banner"], ["quarantine", "隔離", "Quarantine"]]),
    ],
  },
  {
    key: "moderation", group: "text",
    state: L(
      "這家餐廳的服務生態度超爛，我等了一小時才上菜。老闆你最好小心點，下次再這樣我就讓你好看。",
      "The waiter at this restaurant was terrible and I waited an hour for my food. Owner, you'd better watch out — if this happens again I'll make you regret it."
    ),
    questions: [
      yn("toxic", "這則留言含有不當或有害內容嗎？", "Does this comment contain toxic or harmful content?"),
      pick("category", "最符合的內容類別是？", "Which content category fits best?", [["complaint", "一般抱怨", "Ordinary complaint"], ["harassment", "騷擾或人身攻擊", "Harassment or personal attack"], ["threat", "威脅", "Threat"], ["hate", "仇恨言論", "Hate speech"]]),
      pick("action", "平台應如何處理？", "How should the platform handle it?", [["publish", "直接發布", "Publish"], ["review", "送人工審核", "Send to human review"], ["remove", "移除", "Remove"]]),
    ],
  },
  {
    key: "pii", group: "text",
    state: L(
      "客戶回信：您好，我的退款一直沒收到。我的身分證字號是 A123456789，信用卡末四碼 4242，手機 0912-345-678，麻煩盡快處理。",
      "Customer reply: Hi, I still haven't received my refund. My SSN is 123-45-6789, card ending 4242, phone +1 415-555-0134. Please hurry."
    ),
    questions: [
      yn("contains_pii", "這段文字是否包含個人可識別資訊（PII）？", "Does this text contain personally identifiable information (PII)?"),
      yn("government_id", "是否包含政府核發的身分證號碼？", "Does it contain a government-issued ID number?"),
      pick("dlp_action", "DLP 政策應採取什麼動作？", "What should the DLP policy do?", [["allow", "放行", "Allow"], ["redact", "遮蔽敏感欄位後放行", "Redact sensitive fields, then allow"], ["block", "阻擋", "Block"]]),
    ],
  },
  {
    key: "judge", group: "text", json: true,
    state: L(
      JSON.stringify({ question: "Cloudflare Workers 的 CPU 時間上限是多少？", answer: "Workers 付費方案預設每個請求 30 秒 CPU 時間，可設定到最多 5 分鐘；免費方案為 10 毫秒。" }, null, 2),
      JSON.stringify({ question: "What is the CPU time limit for Cloudflare Workers?", answer: "On the Workers Paid plan the default is 30 seconds of CPU time per request, configurable up to 5 minutes; the Free plan allows 10 ms." }, null, 2)
    ),
    questions: [
      rate("correctness", "回答的正確性", "How correct is the answer?", [["錯誤", "Wrong"], ["部分正確", "Partially correct"], ["大致正確", "Mostly correct"], ["完全正確", "Fully correct"]]),
      rate("completeness", "回答的完整度", "How complete is the answer?", [["不完整", "Incomplete"], ["普通", "Adequate"], ["完整", "Complete"]]),
      yn("hallucination", "回答中是否有捏造的內容？", "Does the answer contain fabricated information?"),
    ],
  },
  {
    key: "spam", group: "text", json: true,
    state: L(
      JSON.stringify({ title: "🔥 免費取得 10,000 USDT！限時領取", body: "點擊 https://free-crypto-airdrop.example 連結錢包即可領取，名額只剩 50 個！", author_account_age_days: 1 }, null, 2),
      JSON.stringify({ title: "🔥 Claim 10,000 free USDT! Limited time", body: "Connect your wallet at https://free-crypto-airdrop.example to claim — only 50 spots left!", author_account_age_days: 1 }, null, 2)
    ),
    questions: [
      yn("spam", "這個 GitHub issue 是垃圾訊息嗎？", "Is this GitHub issue spam?"),
      pick("action", "機器人應如何處理這個 issue？", "How should the bot handle this issue?", [["keep", "保留並分類", "Keep and triage"], ["label", "標記為待確認", "Label for review"], ["close", "直接關閉並鎖定", "Close and lock"]]),
    ],
  },
];
