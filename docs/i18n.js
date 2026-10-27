/* NETRA UI strings — English default, Hindi optional. (IIFE: global scope clean) */
(() => {
/* NETRA UI strings — English default, Hindi optional. */
const STR = {
  en: {
    appName: "NETRA",
    newTask: "New task",
    tasks: "Tasks",
    files: "Files",
    keys: "Keys",
    setup: "Setup",
    live: "Live",
    back: "Back",
    stop: "Stop",
    clear: "Clear",
    run: "Run",
    send: "Send",
    placeholder: "Reply to NETRA or hold to talk",
    searchTasks: "Search tasks…",
    filterAll: "All",
    filterRunning: "Running",
    filterDone: "Done",
    filterFailed: "Failed",
    emptyTitle: "What should I do?",
    emptyBody: "Describe a task — I will open a real browser, complete it and give you a verified result.",
    sug1: "Collect the top 10 Hacker News posts and save them as CSV",
    sug2: "Find the top 5 noise-cancelling headphones with prices",
    sug3: "Summarise the first paragraph of the Wikipedia article on web scraping",
    queued: "Queued — one run at a time. It will start as soon as the current run finishes.",
    running: "Running…",
    done: "Done",
    failed: "Failed",
    noTasks: "No tasks yet. Start one below.",
    noMatch: "Nothing matches this filter.",
    noFiles: "No files yet.",
    noLive: "No runs yet.",
    copy: "Copy",
    download: "Download",
    captures: "Captures",
    plan: "Plan",
    status: "Status",
    language: "Language",
    theme: "Theme",
    model: "Model",
    quickActions: "Quick actions",
    dataExtract: "Extract data",
    capturePage: "Capture page",
    summarise: "Summarise page",
    stopTask: "Stop running task",
    connection: "GitHub connection",
    apiKeys: "API keys",
    activeModel: "Active model",
    limits: "Task limits",
    pipeline: "Pipeline status",
    save: "Save",
    saveTest: "Save and test",
    apply: "Apply",
    saved: "Saved",
    notSet: "Not set",
    tokenHint: "Token stays in your browser. Permissions: Issues RW · Contents R · Actions RW · Secrets RW · Variables RW",
    owner: "Username or organisation",
    repo: "Repository",
    branch: "Branch",
    token: "Personal access token",
    steps: "Steps per phase",
    phases: "Max phases",
    accuracy: "Accuracy target (%)",
    welcome: "Ready",
  },
  hi: {
    appName: "नेत्र",
    newTask: "नया काम",
    tasks: "काम",
    files: "फ़ाइलें",
    keys: "की",
    setup: "सेटअप",
    live: "लाइव",
    back: "वापस",
    stop: "रोकें",
    clear: "साफ़ करें",
    run: "चलाएँ",
    send: "भेजें",
    placeholder: "नेत्र को लिखें या बोलने के लिए दबाए रखें",
    searchTasks: "काम खोजें…",
    filterAll: "सभी",
    filterRunning: "चल रहे",
    filterDone: "पूरे",
    filterFailed: "फ़ेल",
    emptyTitle: "क्या करना है?",
    emptyBody: "काम लिखें — मैं असली ब्राउज़र खोलकर पूरा करूँगा और जाँचा हुआ नतीजा दूँगा।",
    sug1: "Hacker News के टॉप 10 पोस्ट CSV में सेव करो",
    sug2: "5 सबसे अच्छे नॉइज़-कैंसलिंग हेडफ़ोन और उनके दाम निकालो",
    sug3: "वेब स्क्रैपिंग वाले विकिपीडिया पेज का पहला पैराग्राफ़ समझाओ",
    queued: "कतार में — एक बार में एक काम चलता है। मौजूदा काम खत्म होते ही शुरू होगा।",
    running: "चल रहा है…",
    done: "पूरा",
    failed: "फ़ेल",
    noTasks: "अभी कोई काम नहीं। नीचे से शुरू करें।",
    noMatch: "इस फ़िल्टर में कुछ नहीं।",
    noFiles: "अभी कोई फ़ाइल नहीं।",
    noLive: "अभी कोई रन नहीं।",
    copy: "कॉपी",
    download: "डाउनलोड",
    captures: "स्क्रीनशॉट",
    plan: "योजना",
    status: "स्थिति",
    language: "भाषा",
    theme: "थीम",
    model: "मॉडल",
    quickActions: "तुरंत काम",
    dataExtract: "डेटा निकालें",
    capturePage: "पेज कैप्चर करें",
    summarise: "पेज समझाएँ",
    stopTask: "चल रहा काम रोकें",
    connection: "GitHub कनेक्शन",
    apiKeys: "API की",
    activeModel: "चालू मॉडल",
    limits: "काम की सीमा",
    pipeline: "पाइपलाइन स्थिति",
    save: "सेव",
    saveTest: "सेव और जाँच",
    apply: "लागू करें",
    saved: "सेव हो गया",
    notSet: "सेट नहीं",
    tokenHint: "टोकन आपके ब्राउज़र में रहता है। अनुमतियाँ: Issues RW · Contents R · Actions RW · Secrets RW · Variables RW",
    owner: "यूज़रनेम या संस्था",
    repo: "रिपॉज़िटरी",
    branch: "ब्रांच",
    token: "पर्सनल एक्सेस टोकन",
    steps: "हर चरण में स्टेप",
    phases: "अधिकतम चरण",
    accuracy: "सटीकता लक्ष्य (%)",
    welcome: "तैयार",
  },
};

let LANG = (() => {
  try {
    return localStorage.getItem("netra_lang") === "hi" ? "hi" : "en";
  } catch {
    return "en";
  }
})();

function t(key) {
  return (STR[LANG] && STR[LANG][key]) || STR.en[key] || key;
}

function setLang(lang) {
  LANG = lang === "hi" ? "hi" : "en";
  try {
    localStorage.setItem("netra_lang", LANG);
  } catch {}
  applyI18n();
  document.documentElement.lang = LANG;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  const lbl = document.getElementById("langBtn");
  if (lbl) lbl.textContent = LANG === "en" ? "EN" : "हिं";
  document.documentElement.lang = LANG;
  document.dispatchEvent(new CustomEvent("netra:lang"));
}

window.NETRA_I18N = { t, setLang, applyI18n, get lang() { return LANG; } };

})();
