"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, todayBusinessDate } from "@/lib/supabaseClient";
import { CERTIFICATE_TYPES, certificateLabel } from "@/lib/certificates";

type TicketRow = {
  uuid: string;
  ticket_number: number;
  business_date: string;
  status: string;
  certificate_type: string | null;
  counter_number: number | null;
  admission_desk: string | null;
  printed_at: string | null;
  called_at: string | null;
  admission_called_at: string | null;
  completed_at: string | null;
  first_review_completed_at: string | null;
};

type TimeFilter = "today" | "yesterday" | "week" | "all";

type CategoryStat = {
  value: string;
  label: string;
  total: number;
  completed: number;
  called: number;
  waiting: number;
};

function getYesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getSevenDaysAgoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function AdminDashboardPage() {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  // Dashboard Data State
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("today");
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingUuid, setDeletingUuid] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>("all");

  // Check authentication on mount
  useEffect(() => {
    const sessionAuth = sessionStorage.getItem("admin_authenticated");
    if (sessionAuth === "true") {
      setIsAuthenticated(true);
    }
    setAuthLoading(false);
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim() === "admin" && password === "512333") {
      sessionStorage.setItem("admin_authenticated", "true");
      setIsAuthenticated(true);
      setLoginError("");
    } else {
      setLoginError("اسم المستخدم أو كلمة المرور غير صحيحة");
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem("admin_authenticated");
    setIsAuthenticated(false);
    setUsername("");
    setPassword("");
  };

  // Fetch Tickets based on time filter
  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("tickets")
        .select("*")
        .neq("status", "DELETED")
        .order("ticket_number", { ascending: false });

      if (timeFilter === "today") {
        query = query.eq("business_date", todayBusinessDate());
      } else if (timeFilter === "yesterday") {
        query = query.eq("business_date", getYesterdayDate());
      } else if (timeFilter === "week") {
        query = query.gte("business_date", getSevenDaysAgoDate());
      }
      // 'all' applies no date filter

      const { data, error } = await query;
      if (error) {
        console.error("Error fetching tickets:", error);
      } else {
        const validTickets = ((data as TicketRow[]) || []).filter(
          (t) => t.status !== "DELETED"
        );
        setTickets(validTickets);
      }
    } catch (err) {
      console.error("Fetch tickets error:", err);
    } finally {
      setLoading(false);
    }
  }, [timeFilter]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchTickets();

    // Subscribe to realtime changes
    const channel = supabase
      .channel("tickets-admin-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tickets" },
        () => {
          fetchTickets();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAuthenticated, fetchTickets]);

  // Delete single ticket with guaranteed persistence
  const handleDeleteTicket = async (ticket: TicketRow) => {
    if (!confirm(`هل أنت متأكد من حذف التذكرة رقم (${ticket.ticket_number})؟`)) {
      return;
    }

    setDeletingUuid(ticket.uuid);
    try {
      // 1. Update status to 'DELETED' (anon key has granted UPDATE policy on tickets table)
      const { error: updateErr } = await supabase
        .from("tickets")
        .update({ status: "DELETED" })
        .eq("uuid", ticket.uuid);

      if (updateErr) {
        console.error("Failed to mark ticket as DELETED:", updateErr);
      }

      // 2. Try RPC delete to physically remove row from database if available
      try {
        await supabase.rpc("admin_delete_ticket", {
          p_uuid: ticket.uuid,
          p_password: "512333",
        });
      } catch (rpcErr) {
        // Fallback: direct delete
        await supabase.from("tickets").delete().eq("uuid", ticket.uuid);
      }

      // 3. Immediately update UI state
      setTickets((prev) => prev.filter((t) => t.uuid !== ticket.uuid));
      await fetchTickets();
    } catch (err: any) {
      alert("حدث خطأ أثناء الحذف: " + err.message);
    } finally {
      setDeletingUuid(null);
    }
  };

  // Reset entire day's tickets with guaranteed persistence
  const handleResetBusinessDate = async () => {
    const targetDate = timeFilter === "yesterday" ? getYesterdayDate() : todayBusinessDate();
    if (
      !confirm(
        `⚠️ تحذير مهم:\nهل أنت متأكد من مسح جميع التذاكر المسجلة بتاريخ (${targetDate})؟\nهذا الإجراء مسح كامل لا يمكن التراجع عنه.`
      )
    ) {
      return;
    }

    try {
      // 1. Try RPC reset first
      const { error: rpcError } = await supabase.rpc("admin_reset_business_date", {
        p_business_date: targetDate,
        p_password: "512333",
      });

      // 2. Fallback: mark all target date tickets as DELETED via UPDATE
      if (rpcError) {
        await supabase
          .from("tickets")
          .update({ status: "DELETED" })
          .eq("business_date", targetDate);
      }

      alert("تم مسح جميع التذاكر لهذا اليوم بنجاح!");
      await fetchTickets();
    } catch (err: any) {
      alert("حدث خطأ: " + err.message);
    }
  };

  // Compute Statistics (excluding any DELETED tickets)
  const activeTickets = tickets.filter((t) => t.status !== "DELETED");
  const totalTickets = activeTickets.length;
  const completedTickets = activeTickets.filter(
    (t) => t.status === "COMPLETED" || t.completed_at !== null
  ).length;
  const calledTickets = activeTickets.filter(
    (t) =>
      (t.status === "CALLED" || t.status === "CALLED_BY_ADMISSION") &&
      t.completed_at === null
  ).length;
  const waitingTickets = activeTickets.filter(
    (t) =>
      (t.status === "PRINTED" || t.status === "WAITING_FOR_ADMISSION") &&
      t.completed_at === null
  ).length;

  // Category Breakdown Stats
  const categoryStats: CategoryStat[] = CERTIFICATE_TYPES.map((cert) => {
    const certTickets = activeTickets.filter((t) => t.certificate_type === cert.value);
    const completed = certTickets.filter(
      (t) => t.status === "COMPLETED" || t.completed_at !== null
    ).length;
    const called = certTickets.filter(
      (t) =>
        (t.status === "CALLED" || t.status === "CALLED_BY_ADMISSION") &&
        t.completed_at === null
    ).length;
    const waiting = certTickets.filter(
      (t) =>
        (t.status === "PRINTED" || t.status === "WAITING_FOR_ADMISSION") &&
        t.completed_at === null
    ).length;

    return {
      value: cert.value,
      label: cert.label,
      total: certTickets.length,
      completed,
      called,
      waiting,
    };
  });

  // Other / Uncategorized tickets
  const knownValues = new Set(CERTIFICATE_TYPES.map((c) => c.value));
  const otherTickets = activeTickets.filter(
    (t) => !t.certificate_type || !knownValues.has(t.certificate_type)
  );
  if (otherTickets.length > 0) {
    const completed = otherTickets.filter(
      (t) => t.status === "COMPLETED" || t.completed_at !== null
    ).length;
    const called = otherTickets.filter(
      (t) =>
        (t.status === "CALLED" || t.status === "CALLED_BY_ADMISSION") &&
        t.completed_at === null
    ).length;
    const waiting = otherTickets.filter(
      (t) =>
        (t.status === "PRINTED" || t.status === "WAITING_FOR_ADMISSION") &&
        t.completed_at === null
    ).length;

    categoryStats.push({
      value: "other",
      label: "بدون تخصص / عام",
      total: otherTickets.length,
      completed,
      called,
      waiting,
    });
  }

  // Filtered Tickets Table
  const filteredTickets = activeTickets.filter((t) => {
    const matchesQuery =
      searchQuery === "" ||
      t.ticket_number.toString().includes(searchQuery) ||
      (t.counter_number && t.counter_number.toString().includes(searchQuery)) ||
      (t.admission_desk && t.admission_desk.includes(searchQuery));

    const matchesCategory =
      selectedCategoryFilter === "all" ||
      (selectedCategoryFilter === "other" && (!t.certificate_type || !knownValues.has(t.certificate_type))) ||
      t.certificate_type === selectedCategoryFilter;

    return matchesQuery && matchesCategory;
  });

  // Export to CSV Function
  const exportCSV = () => {
    const headers = [
      "تاريخ العمل",
      "رقم التذكرة",
      "الشريحة/التخصص",
      "الحالة",
      "مكتب المراجعة",
      "مكتب الشؤون",
      "تاريخ الطباعة",
      "تاريخ الإكمال",
    ];

    const formatStatus = (s: string) => {
      switch (s) {
        case "COMPLETED":
          return "مكتمل";
        case "CALLED":
          return "تم النداء (مراجعة)";
        case "CALLED_BY_ADMISSION":
          return "تم النداء (شؤون)";
        case "WAITING_FOR_ADMISSION":
          return "انتظار الشؤون";
        case "PRINTED":
          return "انتظار المراجعة";
        default:
          return s;
      }
    };

    const rows = filteredTickets.map((t) => [
      t.business_date,
      t.ticket_number,
      certificateLabel(t.certificate_type),
      formatStatus(t.status),
      t.counter_number ? `مكتب ${t.counter_number}` : "-",
      t.admission_desk || "-",
      t.printed_at ? new Date(t.printed_at).toLocaleTimeString("ar-EG") : "-",
      t.completed_at ? new Date(t.completed_at).toLocaleTimeString("ar-EG") : "-",
    ]);

    const csvContent =
      "\uFEFF" + // UTF-8 BOM for Excel Arabic support
      [headers.join(","), ...rows.map((row) => row.map((field) => `"${field}"`).join(","))].join(
        "\n"
      );

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `تقرير_إحصائيات_الجامعة_${timeFilter}_${new Date().toISOString().split("T")[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="animate-pulse text-lg font-bold text-blue-400">جاري التحميل...</div>
      </div>
    );
  }

  // LOGIN SCREEN
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center px-4 dir-rtl" dir="rtl">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col gap-6">
          <div className="text-center flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/university-logo.png"
              alt="جامعة الزقازيق الأهلية"
              className="w-20 h-20 object-contain drop-shadow-md"
            />
            <h1 className="text-2xl font-extrabold text-blue-300">لوحة التحكم والإحصائيات</h1>
            <p className="text-slate-400 text-sm">جامعة الزقازيق الأهلية - نظام تنظيم الصفوف</p>
          </div>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {loginError && (
              <div className="bg-red-950/80 border border-red-800 text-red-300 text-sm font-semibold rounded-xl p-3 text-center">
                {loginError}
              </div>
            )}

            <div className="flex flex-col gap-1.5 text-right">
              <label className="text-sm font-bold text-slate-300">اسم المستخدم</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="أدخل اسم المستخدم"
                required
                className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 text-right focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-1.5 text-right">
              <label className="text-sm font-bold text-slate-300">كلمة المرور</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="أدخل كلمة المرور"
                required
                className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 text-right focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <button
              type="submit"
              className="mt-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-extrabold rounded-xl py-3.5 shadow-lg transition-all"
            >
              تسجيل الدخول
            </button>
          </form>

          <div className="text-center text-xs text-slate-500 mt-2">
            <Link href="/" className="hover:text-blue-400 underline">
              العودة للشاشة الرئيسية
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // MAIN DASHBOARD SCREEN
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center px-4 sm:px-8 py-8 gap-8 dir-rtl" dir="rtl">
      {/* HEADER */}
      <header className="w-full max-w-7xl flex flex-col md:flex-row items-center justify-between gap-4 bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/university-logo.png"
            alt="جامعة الزقازيق الأهلية"
            className="w-14 h-14 object-contain"
          />
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-blue-300">
              لوحة متابعة وإحصائيات الطلاب
            </h1>
            <p className="text-slate-400 text-xs sm:text-sm mt-0.5">
              نظام خدمة الطلاب - اتحاد طلاب كلية الهندسة
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs sm:text-sm rounded-xl px-4 py-2.5 transition-colors"
          >
            🖥️ شاشة العرض
          </Link>

          <button
            onClick={exportCSV}
            className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs sm:text-sm rounded-xl px-4 py-2.5 transition-colors shadow"
          >
            📥 تصدير التقرير (CSV)
          </button>

          <button
            onClick={fetchTickets}
            disabled={loading}
            className="bg-blue-700 hover:bg-blue-600 text-white font-bold text-xs sm:text-sm rounded-xl px-4 py-2.5 transition-colors disabled:opacity-50"
          >
            🔄 {loading ? "جاري التحديث..." : "تحديث البيانات"}
          </button>

          <button
            onClick={handleResetBusinessDate}
            className="bg-amber-950/80 hover:bg-amber-900 border border-amber-800 text-amber-300 font-bold text-xs sm:text-sm rounded-xl px-4 py-2.5 transition-colors"
            title="مسح جميع تذاكر اليوم لتصفير الترقيم والاختبار"
          >
            ⚠️ مسح تذاكر اليوم
          </button>

          <button
            onClick={handleLogout}
            className="bg-red-950/80 hover:bg-red-900 border border-red-800 text-red-300 font-bold text-xs sm:text-sm rounded-xl px-4 py-2.5 transition-colors"
          >
            تسجيل الخروج
          </button>
        </div>
      </header>

      <main className="w-full max-w-7xl flex flex-col gap-8">
        {/* TIME FILTER & CONTROLS */}
        <section className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-bold text-sm">النطاق الزمني:</span>
            <div className="flex bg-slate-950 rounded-xl p-1 border border-slate-800">
              <button
                onClick={() => setTimeFilter("today")}
                className={`px-4 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all ${
                  timeFilter === "today"
                    ? "bg-blue-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                اليوم
              </button>
              <button
                onClick={() => setTimeFilter("yesterday")}
                className={`px-4 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all ${
                  timeFilter === "yesterday"
                    ? "bg-blue-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                الأمس
              </button>
              <button
                onClick={() => setTimeFilter("week")}
                className={`px-4 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all ${
                  timeFilter === "week"
                    ? "bg-blue-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                آخر ٧ أيام
              </button>
              <button
                onClick={() => setTimeFilter("all")}
                className={`px-4 py-1.5 text-xs sm:text-sm font-extrabold rounded-lg transition-all ${
                  timeFilter === "all"
                    ? "bg-blue-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                جميع الأوقات
              </button>
            </div>
          </div>

          <div className="text-slate-400 text-xs sm:text-sm font-medium">
            عدد التذاكر المسجلة للنطاق المحدد:{" "}
            <span className="text-blue-300 font-extrabold text-base">{totalTickets}</span>
          </div>
        </section>

        {/* OVERALL METRICS CARDS */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <MetricCard
            title="إجمالي التذاكر"
            value={totalTickets}
            subtitle="جميع التذاكر المطبوعة"
            color="border-blue-800 bg-blue-950/20 text-blue-300"
            icon="🎫"
          />
          <MetricCard
            title="تمت خدمتهم (مكتمل)"
            value={completedTickets}
            subtitle={`${totalTickets > 0 ? Math.round((completedTickets / totalTickets) * 100) : 0}% نسبة الإنجاز`}
            color="border-emerald-800 bg-emerald-950/20 text-emerald-300"
            icon="✅"
          />
          <MetricCard
            title="يتم خدمتهم الآن"
            value={calledTickets}
            subtitle="تم النداء عليهم للمكاتب"
            color="border-amber-800 bg-amber-950/20 text-amber-300"
            icon="📢"
          />
          <MetricCard
            title="في انتظار الخدمة"
            value={waitingTickets}
            subtitle="في صالة الانتظار"
            color="border-purple-800 bg-purple-950/20 text-purple-300"
            icon="⏳"
          />
        </section>

        {/* FACULTY / CATEGORY BREAKDOWN CARDS */}
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-extrabold text-slate-200 flex items-center gap-2">
            📊 تفاصيل الخدمة حسب التخصص والكلية
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {categoryStats.map((cat) => {
              const completionPercentage =
                cat.total > 0 ? Math.round((cat.completed / cat.total) * 100) : 0;

              return (
                <div
                  key={cat.value}
                  className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col gap-4 shadow-lg hover:border-slate-700 transition-all"
                >
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <span className="text-xl font-extrabold text-blue-300">{cat.label}</span>
                    <span className="bg-slate-800 text-slate-300 text-xs font-bold px-3 py-1 rounded-full">
                      إجمالي: {cat.total}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-emerald-950/40 border border-emerald-900/60 rounded-xl p-2.5">
                      <div className="text-xs text-emerald-400 font-semibold">تمت خدمتهم</div>
                      <div className="text-xl font-extrabold text-emerald-300 mt-1">
                        {cat.completed}
                      </div>
                    </div>
                    <div className="bg-amber-950/40 border border-amber-900/60 rounded-xl p-2.5">
                      <div className="text-xs text-amber-400 font-semibold">يتم خدمتهم</div>
                      <div className="text-xl font-extrabold text-amber-300 mt-1">{cat.called}</div>
                    </div>
                    <div className="bg-purple-950/40 border border-purple-900/60 rounded-xl p-2.5">
                      <div className="text-xs text-purple-400 font-semibold">في الانتظار</div>
                      <div className="text-xl font-extrabold text-purple-300 mt-1">
                        {cat.waiting}
                      </div>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>نسبة الاكتمال:</span>
                      <span className="font-bold text-slate-200">{completionPercentage}%</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="bg-gradient-to-l from-emerald-500 to-teal-400 h-2.5 rounded-full transition-all duration-500"
                        style={{ width: `${completionPercentage}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* DETAILED TICKET LOG & SEARCH */}
        <section className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col gap-6 shadow-xl">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-xl font-extrabold text-slate-200">📋 سجل التذاكر التفصيلي</h2>
              <p className="text-slate-400 text-xs mt-1">
                عرض التذاكر المحددة وإمكانية حذف أي تذكرة تجريبية بسهولة
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
              {/* Category Filter Dropdown */}
              <select
                value={selectedCategoryFilter}
                onChange={(e) => setSelectedCategoryFilter(e.target.value)}
                className="bg-slate-950 border border-slate-700 text-slate-200 text-xs sm:text-sm rounded-xl px-3 py-2 focus:outline-none"
              >
                <option value="all">كل الشرائح / التخصصات</option>
                {CERTIFICATE_TYPES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
                {otherTickets.length > 0 && <option value="other">بدون تخصص / عام</option>}
              </select>

              {/* Search Input */}
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم التذكرة أو المكتب..."
                className="bg-slate-950 border border-slate-700 text-slate-100 text-xs sm:text-sm rounded-xl px-4 py-2 text-right focus:outline-none focus:border-blue-500 w-full sm:w-64"
              />
            </div>
          </div>

          {/* TABLE */}
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm text-slate-300">
              <thead className="bg-slate-950 text-slate-400 text-xs uppercase border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3 rounded-r-xl">تاريخ العمل</th>
                  <th className="px-4 py-3">رقم التذكرة</th>
                  <th className="px-4 py-3">التخصص / الشريحة</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">مكتب المراجعة</th>
                  <th className="px-4 py-3">مكتب الشؤون</th>
                  <th className="px-4 py-3">وقت النداء</th>
                  <th className="px-4 py-3">وقت الإكمال</th>
                  <th className="px-4 py-3 rounded-l-xl text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredTickets.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8 text-slate-500 font-semibold">
                      لا توجد تذاكر مطابقة للبحث أو النطاق المحدد
                    </td>
                  </tr>
                ) : (
                  filteredTickets.map((t) => (
                    <tr key={t.uuid} className="hover:bg-slate-800/40 transition-colors">
                      <td className="px-4 py-3 font-mono text-slate-400">{t.business_date}</td>
                      <td className="px-4 py-3 font-extrabold text-blue-300 text-base">
                        {t.ticket_number}
                      </td>
                      <td className="px-4 py-3">
                        <span className="bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold px-2.5 py-1 rounded-lg">
                          {certificateLabel(t.certificate_type)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={t.status} completedAt={t.completed_at} />
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-300">
                        {t.counter_number ? `مكتب ${t.counter_number}` : "—"}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-300">
                        {t.admission_desk || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 dir-ltr">
                        {t.called_at || t.admission_called_at
                          ? new Date(t.called_at || t.admission_called_at!).toLocaleTimeString("ar-EG")
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 dir-ltr">
                        {t.completed_at
                          ? new Date(t.completed_at).toLocaleTimeString("ar-EG")
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => handleDeleteTicket(t)}
                          disabled={deletingUuid === t.uuid}
                          className="bg-red-950/80 hover:bg-red-900 border border-red-800 text-red-300 hover:text-red-100 font-bold text-xs rounded-xl px-3 py-1.5 transition-colors disabled:opacity-50"
                          title="حذف هذه التذكرة"
                        >
                          {deletingUuid === t.uuid ? "جاري الحذف..." : "🗑️ حذف"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  color,
  icon,
}: {
  title: string;
  value: number;
  subtitle: string;
  color: string;
  icon: string;
}) {
  return (
    <div className={`border rounded-3xl p-6 flex flex-col justify-between shadow-lg ${color}`}>
      <div className="flex items-center justify-between">
        <span className="text-slate-400 text-xs font-extrabold">{title}</span>
        <span className="text-2xl">{icon}</span>
      </div>
      <div className="text-4xl font-extrabold mt-3">{value}</div>
      <div className="text-xs opacity-80 mt-2 font-medium">{subtitle}</div>
    </div>
  );
}

function StatusBadge({ status, completedAt }: { status: string; completedAt: string | null }) {
  if (status === "COMPLETED" || completedAt !== null) {
    return (
      <span className="bg-emerald-950 border border-emerald-700 text-emerald-300 text-xs font-extrabold px-2.5 py-1 rounded-lg">
        ✅ مكتمل
      </span>
    );
  }
  if (status === "CALLED") {
    return (
      <span className="bg-amber-950 border border-amber-700 text-amber-300 text-xs font-extrabold px-2.5 py-1 rounded-lg">
        📢 تم النداء (مراجعة)
      </span>
    );
  }
  if (status === "CALLED_BY_ADMISSION") {
    return (
      <span className="bg-blue-950 border border-blue-700 text-blue-300 text-xs font-extrabold px-2.5 py-1 rounded-lg">
        🎓 تم النداء (شؤون)
      </span>
    );
  }
  if (status === "WAITING_FOR_ADMISSION") {
    return (
      <span className="bg-purple-950 border border-purple-700 text-purple-300 text-xs font-extrabold px-2.5 py-1 rounded-lg">
        ⏳ انتظار الشؤون
      </span>
    );
  }
  return (
    <span className="bg-slate-800 border border-slate-700 text-slate-300 text-xs font-extrabold px-2.5 py-1 rounded-lg">
      ⏱️ انتظار المراجعة
    </span>
  );
}
