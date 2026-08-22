"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, todayBusinessDate } from "@/lib/supabaseClient";
import { certificateLabel } from "@/lib/certificates";
import {
  announceAdmissionTicket,
  announceTest,
  announceTicket,
  getArabicVoices,
  getSelectedVoice,
  onVoicesChanged,
  setSelectedVoiceURI,
  speechAvailable,
  unlockSpeech,
} from "@/lib/speech";

// A student is called twice over their visit — once to a first-review
// counter, and again to student affairs for their certificate. Both
// are announcements the waiting hall needs to hear, so the display
// treats them as one time-ordered stream rather than two lists, and
// each entry carries where the student should actually go.
type CalledEntry =
  | { kind: "counter"; ticketNumber: number; at: string; counterNumber: number }
  | { kind: "admission"; ticketNumber: number; at: string; certificateType: string | null };

// Every status meaning "this number was really issued today". A ticket
// must not drop out of the day's total just because it moved further
// down the workflow.
const ISSUED_STATUSES = [
  "PRINTED",
  "CALLED",
  "WAITING_FOR_ADMISSION",
  "CALLED_BY_ADMISSION",
  "COMPLETED",
  "NO_SHOW",
  "ADMISSION_NO_SHOW",
];
// Everything past the general waiting hall — i.e. already called at
// least once.
const CALLED_STATUSES = [
  "CALLED",
  "WAITING_FOR_ADMISSION",
  "CALLED_BY_ADMISSION",
  "COMPLETED",
  "NO_SHOW",
  "ADMISSION_NO_SHOW",
];

type DisplayData = {
  // Last 5 calls, most recent first — not just the single latest one.
  recentlyCalled: CalledEntry[];
  reviewWaitingNumbers: number[];
  admissionWaitingNumbers: number[];
  stats: { totalToday: number; waiting: number; called: number };
};

const EMPTY: DisplayData = {
  recentlyCalled: [],
  reviewWaitingNumbers: [],
  admissionWaitingNumbers: [],
  stats: { totalToday: 0, waiting: 0, called: 0 },
};

async function fetchDisplayData(businessDate: string): Promise<DisplayData> {
  const [
    { data: calledRows },
    { data: admissionRows },
    { data: reviewWaitingRows },
    { data: admissionWaitingRows },
    { count: totalToday },
    { count: waiting },
    { count: called },
  ] = await Promise.all([
    supabase
      .from("tickets")
      .select("ticket_number, counter_number, called_at")
      .eq("business_date", businessDate)
      .eq("status", "CALLED")
      .order("called_at", { ascending: false })
      .limit(5),
    supabase
      .from("tickets")
      .select("ticket_number, certificate_type, admission_called_at")
      .eq("business_date", businessDate)
      .eq("status", "CALLED_BY_ADMISSION")
      .order("admission_called_at", { ascending: false })
      .limit(5),
    supabase
      .from("tickets")
      .select("ticket_number")
      .eq("business_date", businessDate)
      .eq("status", "PRINTED")
      .is("called_at", null)
      .order("ticket_number", { ascending: true })
      .limit(8),
    supabase
      .from("tickets")
      .select("ticket_number")
      .eq("business_date", businessDate)
      .eq("status", "WAITING_FOR_ADMISSION")
      .order("ticket_number", { ascending: true })
      .limit(8),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .in("status", ISSUED_STATUSES),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .in("status", ["PRINTED", "WAITING_FOR_ADMISSION"]),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .in("status", CALLED_STATUSES),
  ]);

  const merged: CalledEntry[] = [
    ...(calledRows || []).map(
      (r: any): CalledEntry => ({
        kind: "counter",
        ticketNumber: r.ticket_number,
        at: r.called_at,
        counterNumber: r.counter_number,
      })
    ),
    ...(admissionRows || []).map(
      (r: any): CalledEntry => ({
        kind: "admission",
        ticketNumber: r.ticket_number,
        at: r.admission_called_at,
        certificateType: r.certificate_type,
      })
    ),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);

  return {
    recentlyCalled: merged,
    reviewWaitingNumbers: (reviewWaitingRows || []).map((r: any) => r.ticket_number),
    admissionWaitingNumbers: (admissionWaitingRows || []).map((r: any) => r.ticket_number),
    stats: {
      totalToday: totalToday ?? 0,
      waiting: waiting ?? 0,
      called: called ?? 0,
    },
  };
}

export default function DisplayPage() {
  const [data, setData] = useState<DisplayData>(EMPTY);
  const [offline, setOffline] = useState(false);
  const [flash, setFlash] = useState(false);
  const [soundAvailable, setSoundAvailable] = useState(false);
  // Both `todayBusinessDate()` (depends on the machine's local clock —
  // the build server and a visitor's browser can disagree, especially
  // near midnight) and `speechAvailable()` (reads `window`, absent
  // during the static server-rendered shell) must NOT be computed
  // during the initial render, or that render won't match what the
  // server already sent down — a React hydration error. Both start
  // blank/false and get filled in from an effect, which only runs
  // after hydration completes.
  const [businessDate, setBusinessDate] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURIState] = useState("");
  // Unique string keys for every call event already handled.
  // Set<string> | null. null = initial load (must not replay history as new announcements).
  const handledCallKeys = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cleanup = () => {};
    setTimeout(() => {
      setBusinessDate(todayBusinessDate());
      const available = speechAvailable();
      setSoundAvailable(available);
      if (!available) return;

      const syncVoices = () => {
        setVoices(getArabicVoices());
        setSelectedVoiceURIState(getSelectedVoice()?.voiceURI || "");
      };
      syncVoices();
      cleanup = onVoicesChanged(syncVoices);
    }, 0);
    return () => cleanup();
  }, []);

  function chooseVoice(voiceURI: string) {
    setSelectedVoiceURI(voiceURI);
    setSelectedVoiceURIState(voiceURI);
    unlockSpeech();
    announceTest(); // preview immediately so it's obvious what changed
  }

  const refresh = useCallback(async () => {
    if (!businessDate) return;
    try {
      const next = await fetchDisplayData(businessDate);

      const getCallKey = (c: CalledEntry) =>
        c.kind === "counter"
          ? `counter-${c.ticketNumber}-${c.counterNumber}-${c.at}`
          : `admission-${c.ticketNumber}-${c.certificateType || ""}-${c.at}`;

      if (handledCallKeys.current === null) {
        // First load: record existing active calls so we don't replay history
        handledCallKeys.current = new Set(next.recentlyCalled.map(getCallKey));
      } else {
        const newCalls = next.recentlyCalled.filter(
          (c) => !handledCallKeys.current!.has(getCallKey(c))
        );

        if (newCalls.length > 0) {
          setFlash(true);
          setTimeout(() => setFlash(false), 1200);

          [...newCalls]
            .sort((a, b) => a.at.localeCompare(b.at))
            .forEach((c) => {
              handledCallKeys.current!.add(getCallKey(c));
              if (c.kind === "counter") {
                announceTicket(c.ticketNumber, c.counterNumber);
              } else {
                announceAdmissionTicket(c.ticketNumber, certificateLabel(c.certificateType));
              }
            });
        }
      }

      setData(next);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [businessDate]);

  useEffect(() => {
    if (!businessDate) return;
    setTimeout(() => { refresh(); }, 0);

    // Realtime push (instant) — any change to today's tickets triggers
    // a fresh fetch of the computed display payload. A 5s poll is kept
    // as a safety net in case a realtime event is ever missed.
    const channel = supabase
      .channel("tickets-display")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tickets", filter: `business_date=eq.${businessDate}` },
        () => refresh()
      )
      .subscribe();

    const interval = setInterval(refresh, 5000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [refresh, businessDate]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center px-6 py-10 gap-8">
      <header className="w-full max-w-5xl flex flex-col items-center text-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="flex items-center justify-center gap-6 sm:gap-10">
          {/* Left logo: University Student Union */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/union-logo.png"
            alt="اتحاد الطلاب"
            className="w-20 h-20 sm:w-32 sm:h-32 object-contain drop-shadow-md"
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
          {/* Center logo: University logo */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/university-logo.png"
            alt="جامعة الزقازيق الأهلية"
            className="w-24 h-24 sm:w-36 sm:h-36 object-contain drop-shadow-md"
          />
          {/* Right logo: Engineering Student Union */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/eng-union-logo.png"
            alt="اتحاد طلاب كلية الهندسة"
            className="w-20 h-20 sm:w-32 sm:h-32 object-contain drop-shadow-md"
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        </div>

        <div className="w-full mt-4 px-2 sm:px-4">
          <h1 className="w-full flex justify-between text-3xl sm:text-5xl font-extrabold text-blue-300">
            <span>أهلاً</span>
            <span>بكم</span>
            <span>في</span>
            <span>جامعة</span>
            <span>الزقازيق</span>
            <span>الأهلية</span>
          </h1>
          <h2 className="w-full flex justify-between text-xl sm:text-3xl font-extrabold text-white mt-4">
            <span>اتحـاد</span>
            <span>طـلاب</span>
            <span>كليـة</span>
            <span>الـهـندسـة</span>
          </h2>
          <div className="flex items-center justify-center mt-6">
            <span className="text-slate-500 text-sm font-semibold tracking-wider">{businessDate}</span>
          </div>
        </div>
      </header>

      <main className="w-full max-w-5xl flex flex-col items-center gap-6">
        {/* Top Section: يتم خدمته الآن (Full Width) */}
        <section className="w-full bg-slate-900 border-2 border-blue-900 rounded-3xl px-6 py-6 flex flex-col gap-4 shadow-xl">
          <div className="text-blue-300 tracking-wider text-lg sm:text-2xl font-extrabold text-end border-b border-slate-800 pb-3">
            يتم خدمته الآن
          </div>
          {data.recentlyCalled.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 font-bold text-lg sm:text-2xl py-12">
              في انتظار بدء الخدمة
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {data.recentlyCalled.map((c, i) => (
                <div
                  key={`${c.kind}-${c.at}-${c.ticketNumber}`}
                  className={`flex items-center justify-between gap-4 rounded-2xl px-6 transition-colors duration-700 ${
                    i === 0
                      ? `py-5 ${flash ? "bg-green-900/60" : "bg-blue-950/60"} border border-blue-800 shadow-lg`
                      : "py-3 bg-slate-800/60"
                  }`}
                >
                  <span className={`font-extrabold ${i === 0 ? "text-[64px] sm:text-[80px]" : "text-3xl sm:text-4xl text-slate-300"}`}>
                    {c.ticketNumber}
                  </span>
                  {c.kind === "counter" ? (
                    <span className={`font-bold text-end ${i === 0 ? "text-2xl sm:text-4xl text-blue-300" : "text-lg sm:text-2xl text-blue-400"}`}>
                      مكتب رقم {c.counterNumber}
                    </span>
                  ) : (
                    <span className={`font-bold text-end ${i === 0 ? "text-emerald-300" : "text-emerald-400"}`}>
                      <span className={i === 0 ? "text-2xl sm:text-4xl" : "text-lg sm:text-2xl"}>
                        شؤون الطلاب
                      </span>
                      <span className={`block ${i === 0 ? "text-base sm:text-xl" : "text-xs sm:text-sm"} opacity-80 mt-0.5`}>
                        {certificateLabel(c.certificateType)}
                      </span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Bottom Section: 2 Columns for waiting (انتظار المراجعة & انتظار الشؤون) */}
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Column 1: انتظار المراجعة */}
          <section className="bg-slate-900 border-2 border-slate-800 rounded-3xl px-6 py-6 flex flex-col gap-4 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-xs sm:text-sm font-semibold">
                العدد: {data.reviewWaitingNumbers.length}
              </span>
              <span className="text-blue-300 text-lg sm:text-xl font-extrabold">
                انتظار المراجعة
              </span>
            </div>
            {data.reviewWaitingNumbers.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-sm sm:text-base">
                لا يوجد أحد في الانتظار
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 content-start">
                {data.reviewWaitingNumbers.map((n) => (
                  <div
                    key={n}
                    className="bg-slate-800/90 border border-slate-700/60 rounded-2xl py-3.5 text-2xl sm:text-3xl font-bold text-center text-blue-200 shadow-sm"
                  >
                    {n}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Column 2: انتظار الشؤون */}
          <section className="bg-slate-900 border-2 border-slate-800 rounded-3xl px-6 py-6 flex flex-col gap-4 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-xs sm:text-sm font-semibold">
                العدد: {data.admissionWaitingNumbers.length}
              </span>
              <span className="text-emerald-300 text-lg sm:text-xl font-extrabold">
                انتظار الشؤون
              </span>
            </div>
            {data.admissionWaitingNumbers.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-sm sm:text-base">
                لا يوجد أحد في الانتظار
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 content-start">
                {data.admissionWaitingNumbers.map((n) => (
                  <div
                    key={n}
                    className="bg-emerald-950/50 border border-emerald-800/60 rounded-2xl py-3.5 text-2xl sm:text-3xl font-bold text-center text-emerald-200 shadow-sm"
                  >
                    {n}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="flex flex-wrap justify-center gap-5 w-full">
          <Stat label="إجمالي اليوم" value={data.stats.totalToday} />
          <Stat label="في الانتظار" value={data.stats.waiting} />
          <Stat label="تم النداء" value={data.stats.called} />
        </section>
      </main>

      {offline && (
        <div className="fixed bottom-0 left-0 right-0 bg-orange-900 text-orange-200 text-center py-2">
          انقطع الاتصال — جاري إعادة المحاولة…
        </div>
      )}

      {soundAvailable && (
        <div className="fixed top-4 right-4 bg-slate-900 border border-slate-700 rounded-2xl shadow-lg p-3 flex flex-col gap-2 max-w-[240px]">
          {voices.length > 0 && (
            <select
              value={selectedVoiceURI}
              onChange={(e) => chooseVoice(e.target.value)}
              className="bg-slate-800 text-slate-100 text-xs rounded-lg px-2 py-2 border border-slate-700"
            >
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang}){v.localService ? "" : " ★"}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              unlockSpeech();
              announceTest();
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg px-4 py-2"
          >
            🔊 تجربة الصوت
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl px-8 py-5 text-center min-w-[140px]">
      <div className="text-slate-400 text-xs sm:text-sm tracking-widest">{label}</div>
      <div className="text-3xl sm:text-5xl font-extrabold mt-1">{value}</div>
    </div>
  );
}
