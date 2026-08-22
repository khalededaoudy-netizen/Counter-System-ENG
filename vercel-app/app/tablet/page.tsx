import TabletAdmissionPanel from "@/components/TabletAdmissionPanel";

export default function TabletPage() {
  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col items-center px-4 py-8 gap-5">
      <header className="text-center w-full max-w-5xl">
        <h1 className="text-2xl font-extrabold text-blue-900">إدارة شؤون الطلاب — القبول</h1>
        <p className="text-sm text-slate-500 mt-2">نظام إدارة 3 مكاتب من جهاز واحد</p>
      </header>

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4">
        {/* Table 1: Engineering */}
        <TabletAdmissionPanel 
          deskId="tablet-eng-1" 
          selected={["engineering"]} 
          title="مكتب 1 — هندسة" 
        />
        
        {/* Table 2: Engineering */}
        <TabletAdmissionPanel 
          deskId="tablet-eng-2" 
          selected={["engineering"]} 
          title="مكتب 2 — هندسة" 
        />

        {/* Table 3: Nursing */}
        <TabletAdmissionPanel 
          deskId="tablet-nurs-1" 
          selected={["nursing"]} 
          title="مكتب 3 — تمريض" 
        />
      </main>
    </div>
  );
}
