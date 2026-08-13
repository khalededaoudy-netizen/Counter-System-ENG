"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
];
// Everything past the general waiting hall — i.e. already called at
// least once.
const CALLED_STATUSES = ["CALLED", "WAITING_FOR_ADMISSION", "CALLED_BY_ADMISSION", "COMPLETED"];

type DisplayData = {
  // Last 5 calls, most recent first — not just the single latest one.
  // If counter 3 calls #45 and counter 5 calls #46 a moment later,
  // #45's "go to counter 3" must stay on screen, not vanish the
  // instant a different counter calls someone else.
  recentlyCalled: CalledEntry[];
  nextNumbers: number[];
  stats: { totalToday: number; waiting: number; called: number };
};

const EMPTY: DisplayData = {
  recentlyCalled: [],
  nextNumbers: [],
  stats: { totalToday: 0, waiting: 0, called: 0 },
};

async function fetchDisplayData(businessDate: string): Promise<DisplayData> {
  const [
    { data: calledRows },
    { data: admissionRows },
    { data: waitingRows },
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
      .limit(6),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .in("status", ISSUED_STATUSES),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .eq("status", "PRINTED")
      .is("called_at", null),
    supabase
      .from("tickets")
      .select("uuid", { count: "exact", head: true })
      .eq("business_date", businessDate)
      .in("status", CALLED_STATUSES),
  ]);

  const merged: CalledEntry[] = [
    ...(calledRows || []).map(
      (r): CalledEntry => ({
        kind: "counter",
        ticketNumber: r.ticket_number,
        at: r.called_at,
        counterNumber: r.counter_number,
      })
    ),
    ...(admissionRows || []).map(
      (r): CalledEntry => ({
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
    nextNumbers: (waitingRows || []).map((r) => r.ticket_number),
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
  // Newest `called_at` already shown/announced. null = nothing seen
  // yet (first load — must not replay history as new announcements).
  const lastCalledAt = useRef<string | null>(null);

  useEffect(() => {
    setBusinessDate(todayBusinessDate());
    const available = speechAvailable();
    setSoundAvailable(available);
    if (!available) return;

    const syncVoices = () => {
      setVoices(getArabicVoices());
      setSelectedVoiceURIState(getSelectedVoice()?.voiceURI || "");
    };
    syncVoices();
    return onVoicesChanged(syncVoices);
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

      // Anything called after the newest timestamp we've already
      // handled is new. There can be more than one (two counters, or a
      // counter and an admission desk, calling within the same
      // poll/Realtime tick) — announce all of them, oldest first, so
      // they play back in the order they actually happened rather than
      // overlapping or skipping ahead.
      const newCalls = lastCalledAt.current
        ? next.recentlyCalled.filter((c) => c.at > lastCalledAt.current!)
        : [];
      if (lastCalledAt.current !== null && newCalls.length > 0) {
        setFlash(true);
        setTimeout(() => setFlash(false), 1200);
        [...newCalls]
          .sort((a, b) => a.at.localeCompare(b.at))
          .forEach((c) =>
            c.kind === "counter"
              ? announceTicket(c.ticketNumber, c.counterNumber)
              : announceAdmissionTicket(c.ticketNumber, certificateLabel(c.certificateType))
          );
      }
      if (next.recentlyCalled.length > 0) {
        lastCalledAt.current = next.recentlyCalled[0].at; // [0] is the newest (list is sorted desc)
      }

      setData(next);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [businessDate]);

  useEffect(() => {
    if (!businessDate) return;
    refresh();

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
      <header className="flex flex-col items-center text-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/university-logo.png" alt="جامعة الزقازيق الأهلية" className="w-24 h-24 sm:w-32 sm:h-32" />
        <div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-wide text-blue-300">
            أهلاً بكم في جامعة الزقازيق الأهلية
          </h1>
          <div className="text-slate-500 mt-1 text-sm">{businessDate}</div>
        </div>
      </header>

      <main className="w-full max-w-5xl flex flex-col items-center gap-8">
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-6">
          <section className="bg-slate-900 border-2 border-blue-900 rounded-3xl px-6 py-6 flex flex-col gap-3">
            <div className="text-blue-300 tracking-widest text-sm sm:text-lg font-bold text-center">
              يتم خدمته الآن
            </div>
            {data.recentlyCalled.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-600 font-extrabold text-[90px] py-10">
                —
              </div>
            ) : (
              data.recentlyCalled.map((c, i) => (
                <div
                  key={`${c.kind}-${c.at}-${c.ticketNumber}`}
                  className={`flex items-center justify-between gap-3 rounded-2xl px-6 transition-colors duration-700 ${
                    i === 0
                      ? `py-5 ${flash ? "bg-green-900/60" : "bg-blue-950/60"} border border-blue-800`
                      : "py-3 bg-slate-800/60"
                  }`}
                >
                  <span className={`font-extrabold ${i === 0 ? "text-[64px] sm:text-[80px]" : "text-3xl sm:text-4xl text-slate-300"}`}>
                    {c.ticketNumber}
                  </span>
                  {c.kind === "counter" ? (
                    <span className={`font-bold text-end ${i === 0 ? "text-2xl sm:text-3xl text-blue-300" : "text-lg sm:text-xl text-blue-400"}`}>
                      مكتب رقم {c.counterNumber}
                    </span>
                  ) : (
                    <span className={`font-bold text-end ${i === 0 ? "text-emerald-300" : "text-emerald-400"}`}>
                      <span className={i === 0 ? "text-2xl sm:text-3xl" : "text-lg sm:text-xl"}>
                        شؤون الطلاب
                      </span>
                      <span className={`block ${i === 0 ? "text-base sm:text-xl" : "text-xs sm:text-sm"} opacity-80`}>
                        {certificateLabel(c.certificateType)}
                      </span>
                    </span>
                  )}
                </div>
              ))
            )}
          </section>

          <section className="bg-slate-900 border-2 border-slate-800 rounded-3xl px-6 py-6 flex flex-col gap-3">
            <div className="text-slate-400 tracking-widest text-sm sm:text-lg font-bold text-center">الانتظار</div>
            {data.nextNumbers.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-500 py-10">
                لا يوجد أحد في الانتظار
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 content-start">
                {data.nextNumbers.map((n) => (
                  <div
                    key={n}
                    className="bg-slate-800 rounded-xl py-4 text-2xl sm:text-3xl font-bold text-center"
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
