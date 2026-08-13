// Polls /api/display every 2s. Polling (not WebSocket/SSE) is
// intentional — see server.py docstring: simple, robust, and plenty
// fast enough for a waiting-room screen at this scale.
const POLL_MS = 2000;

let lastCalledNumber = null;

async function refresh() {
  try {
    const res = await fetch("/api/display", { cache: "no-store" });
    if (!res.ok) throw new Error("bad status " + res.status);
    const data = await res.json();
    render(data);
    setOffline(false);
  } catch (e) {
    setOffline(true);
  }
}

function render(data) {
  document.getElementById("business-date").textContent = data.business_date;

  const currentEl = document.getElementById("current-number");
  const counterEl = document.getElementById("current-counter");
  if (data.current) {
    currentEl.textContent = data.current.ticket_number;
    counterEl.textContent = "COUNTER " + data.current.counter_number;

    if (lastCalledNumber !== null && data.current.ticket_number !== lastCalledNumber) {
      currentEl.classList.remove("flash");
      void currentEl.offsetWidth; // restart animation
      currentEl.classList.add("flash");
    }
    lastCalledNumber = data.current.ticket_number;
  } else {
    currentEl.textContent = "—";
    counterEl.textContent = "";
  }

  const nextList = document.getElementById("next-list");
  nextList.innerHTML = "";
  if (data.next_numbers.length === 0) {
    const span = document.createElement("span");
    span.className = "next-empty";
    span.textContent = "No one waiting";
    nextList.appendChild(span);
  } else {
    for (const n of data.next_numbers) {
      const span = document.createElement("span");
      span.className = "next-chip";
      span.textContent = n;
      nextList.appendChild(span);
    }
  }

  document.getElementById("stat-total").textContent = data.stats.total_today;
  document.getElementById("stat-waiting").textContent = data.stats.waiting;
  document.getElementById("stat-called").textContent = data.stats.called;
}

function setOffline(isOffline) {
  document.getElementById("offline-banner").hidden = !isOffline;
}

refresh();
setInterval(refresh, POLL_MS);
