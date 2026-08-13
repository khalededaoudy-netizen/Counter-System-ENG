// Arabic voice announcement using the browser's built-in Web Speech
// API (SpeechSynthesis) — free, no external TTS service, works
// offline once the browser has an Arabic voice installed. Quality
// varies a lot by OS/browser (some installed voices are noticeably
// more natural than others, e.g. cloud-backed "Google" voices in
// Chrome vs. older local SAPI voices on Windows), so rather than
// guess, this exposes a picker (see the display page) letting
// whoever sets up the screen choose the best-sounding one available
// on that machine and remembers the choice.

const VOICE_STORAGE_KEY = "queue_voice_uri";

let unlocked = false;
let cachedVoices: SpeechSynthesisVoice[] = [];
const voiceListeners = new Set<() => void>();

function refreshVoiceCache() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  cachedVoices = window.speechSynthesis.getVoices();
  voiceListeners.forEach((cb) => cb());
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  refreshVoiceCache();
  window.speechSynthesis.onvoiceschanged = refreshVoiceCache;
}

/** Voices load asynchronously in most browsers. Subscribe to be
 * notified when the list is ready/changes; returns an unsubscribe fn. */
export function onVoicesChanged(callback: () => void): () => void {
  voiceListeners.add(callback);
  return () => voiceListeners.delete(callback);
}

/** All voices the browser reports for Arabic (any dialect). */
export function getArabicVoices(): SpeechSynthesisVoice[] {
  return cachedVoices.filter((v) => v.lang.toLowerCase().startsWith("ar"));
}

/** Picks a sensible default: the previously-saved choice if it's
 * still available, otherwise a non-local (cloud) Arabic voice if one
 * exists — those are usually the more natural-sounding ones — falling
 * back to whatever Arabic voice is available. */
export function getSelectedVoice(): SpeechSynthesisVoice | null {
  const arabicVoices = getArabicVoices();
  if (arabicVoices.length === 0) return null;

  const savedURI = typeof window !== "undefined" ? localStorage.getItem(VOICE_STORAGE_KEY) : null;
  const saved = savedURI && arabicVoices.find((v) => v.voiceURI === savedURI);
  if (saved) return saved;

  const cloudVoice = arabicVoices.find((v) => !v.localService);
  return cloudVoice || arabicVoices[0];
}

export function setSelectedVoiceURI(voiceURI: string) {
  if (typeof window !== "undefined") localStorage.setItem(VOICE_STORAGE_KEY, voiceURI);
}

/** Some browsers block the first speech utterance until a user
 * gesture on the page. Call this from a click handler once to
 * "warm up" the audio; safe to call repeatedly. */
export function unlockSpeech() {
  if (unlocked || typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const warmup = new SpeechSynthesisUtterance(" ");
  warmup.volume = 0;
  window.speechSynthesis.speak(warmup);
  unlocked = true;
}

/** Two-tone "ding-dong" notification chime, synthesized with the Web
 * Audio API (no sound file to ship/host). Resolves once it's finished
 * playing, so callers can sequence chime → speech → chime. */
function playChime(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve();
    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxClass) return resolve();

    const ctx = new AudioCtxClass();
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.3, now + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.05);
    };

    playTone(880, 0, 0.18); // "تن"
    playTone(1320, 0.22, 0.22); // "تن" (higher)

    setTimeout(() => {
      ctx.close();
      resolve();
    }, 500);
  });
}

function speakOnce(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = getSelectedVoice();
    utterance.lang = voice?.lang || "ar-SA";
    if (voice) utterance.voice = voice;
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    window.speechSynthesis.cancel(); // don't stack announcements if numbers change quickly
    window.speechSynthesis.speak(utterance);
  });
}

/** Chime, then the announcement, then the same chime again — matches
 * how real queue counters cue an announcement. */
async function speak(text: string) {
  await playChime();
  await speakOnce(text);
  await playChime();
}

// If two counters call "next" around the same moment, both announcements
// must still play — one after the other, in the order they were called,
// never overlapping/cutting each other off. A simple FIFO queue plus a
// single drain loop gives that for free, regardless of how many calls
// land in the same polling/Realtime tick.
const announceQueue: string[] = [];
let draining = false;

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (announceQueue.length > 0) {
    const text = announceQueue.shift()!;
    await speak(text);
  }
  draining = false;
}

const ARABIC_ONES = ["صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const ARABIC_TEENS = [
  "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر",
  "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر",
];
const ARABIC_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const ARABIC_HUNDREDS = [
  "", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة",
];

/** Spells a number out as Arabic words (e.g. 12 -> "اثنا عشر") instead of
 * handing the TTS engine bare digits — several installed Arabic voices read
 * a multi-digit number digit-by-digit ("واحد اثنان" for 12) rather than as
 * the whole number, which sounds wrong for a ticket/counter announcement. */
function arabicNumberWords(num: number): string {
  if (num < 0 || !Number.isFinite(num)) return String(num);
  if (num === 0) return ARABIC_ONES[0];
  if (num < 10) return ARABIC_ONES[num];
  if (num < 20) return ARABIC_TEENS[num - 10];
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return ones === 0 ? ARABIC_TENS[tens] : `${ARABIC_ONES[ones]} و${ARABIC_TENS[tens]}`;
  }
  if (num < 1000) {
    const hundreds = Math.floor(num / 100);
    const rest = num % 100;
    const hundredsWord = ARABIC_HUNDREDS[hundreds];
    return rest === 0 ? hundredsWord : `${hundredsWord} و${arabicNumberWords(rest)}`;
  }
  return String(num); // beyond expected ticket range — fall back to digits
}

export function announceTicket(ticketNumber: number, counterNumber: number) {
  announceQueue.push(
    `الرقم ${arabicNumberWords(ticketNumber)}، يرجى التوجه إلى مكتب رقم ${arabicNumberWords(counterNumber)} في قاعة المراجعة`
  );
  void drainQueue();
}

/** Second-stage call: the student already passed the first reviewer and
 * is now wanted at student affairs for their specific certificate. The
 * certificate is spoken because several are queued in parallel — the
 * number alone doesn't tell the student which desk is calling them.
 * Goes through the same FIFO queue as the first-stage announcements so
 * the two stages can never talk over each other. */
export function announceAdmissionTicket(ticketNumber: number, certificateLabel: string) {
  announceQueue.push(
    `الرقم ${arabicNumberWords(ticketNumber)} توجه لمكتب شؤون الطلاب ${certificateLabel}`
  );
  void drainQueue();
}

/** Plays a sample announcement so staff can confirm audio works —
 * and compare how a given voice sounds — without waiting for a real
 * ticket to be called. */
export function announceTest() {
  announceQueue.push("تجربة النداء الصوتي، النظام جاهز");
  void drainQueue();
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}
