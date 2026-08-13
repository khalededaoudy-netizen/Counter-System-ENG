const btn = document.getElementById("call-btn");
const input = document.getElementById("counter-input");
const result = document.getElementById("result");

btn.addEventListener("click", async () => {
  const counterNumber = parseInt(input.value, 10);
  if (!Number.isInteger(counterNumber) || counterNumber < 1) {
    result.textContent = "Enter a valid counter number.";
    result.className = "call-result error";
    return;
  }

  btn.disabled = true;
  result.textContent = "Calling…";
  result.className = "call-result";

  try {
    const res = await fetch("/api/call-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counter_number: counterNumber }),
    });
    const data = await res.json();

    if (data.success) {
      result.textContent = `Called ticket #${data.ticket_number} to counter ${data.counter_number}`;
      result.className = "call-result success";
    } else if (data.reason === "no_waiting_tickets") {
      result.textContent = "No one is waiting right now.";
      result.className = "call-result empty";
    } else {
      result.textContent = "Something went wrong.";
      result.className = "call-result error";
    }
  } catch (e) {
    result.textContent = "Network error — check the connection and try again.";
    result.className = "call-result error";
  } finally {
    btn.disabled = false;
  }
});
