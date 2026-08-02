// The booking desk: fetch open slots, render them in the visitor's timezone,
// book with one POST to /api/schedule/book, and hand back the .ics.
(function () {
  var picker = document.getElementById("slot-picker");
  if (!picker) return;

  var pickerStatus = document.getElementById("picker-status");
  var dayStrip = document.getElementById("day-strip");
  var timeGrid = document.getElementById("time-grid");
  var form = document.getElementById("book-form");
  var readout = document.getElementById("slot-readout");
  var status = document.getElementById("book-status");
  var button = form.querySelector("button[type=submit]");
  var booked = document.getElementById("booked");
  var bookedWhen = document.getElementById("booked-when");
  var icsLink = document.getElementById("ics-download");
  var tzNote = document.getElementById("tz-note");

  var MT = "America/Denver";
  var visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || MT;
  var sameTz = visitorTz === MT;
  tzNote.textContent = sameTz
    ? "Times are shown in Mountain time."
    : "Times are shown in your timezone (" + visitorTz.replace(/_/g, " ") + "), with Mountain time alongside once you pick.";

  var dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  var mtFmt = new Intl.DateTimeFormat("en-US", { timeZone: MT, hour: "numeric", minute: "2-digit" });

  var days = [];        // [{key, label, slots: [iso...]}]
  var selectedDay = null;
  var selectedSlot = null;

  function show(kind, msg) {
    status.className = kind;
    status.textContent = msg;
  }

  function setButton(enabled, label) {
    button.disabled = !enabled;
    button.textContent = label;
  }

  function groupSlots(slots) {
    var map = [];
    var index = {};
    slots.forEach(function (iso) {
      var d = new Date(iso);
      var key = dayFmt.format(d);
      if (!(key in index)) {
        index[key] = map.length;
        map.push({ key: key, slots: [] });
      }
      map[index[key]].slots.push(iso);
    });
    return map;
  }

  function renderDays() {
    dayStrip.textContent = "";
    days.forEach(function (day) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "day-btn";
      b.textContent = day.key;
      b.setAttribute("aria-pressed", day.key === selectedDay ? "true" : "false");
      b.addEventListener("click", function () {
        selectedDay = day.key;
        renderDays();
        renderTimes(day);
      });
      dayStrip.appendChild(b);
    });
  }

  function renderTimes(day) {
    timeGrid.textContent = "";
    day.slots.forEach(function (iso) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "time-btn";
      b.textContent = timeFmt.format(new Date(iso));
      b.setAttribute("aria-pressed", iso === selectedSlot ? "true" : "false");
      b.addEventListener("click", function () {
        selectedSlot = iso;
        renderTimes(day);
        var line = longFmt.format(new Date(iso));
        readout.innerHTML = "";
        readout.append("Selected: ");
        var strong = document.createElement("strong");
        strong.textContent = line;
        readout.append(strong);
        if (!sameTz) readout.append(" (" + mtFmt.format(new Date(iso)) + " Mountain)");
        setButton(true, "Book this time");
      });
      timeGrid.appendChild(b);
    });
  }

  function loadSlots() {
    return fetch("/api/schedule/slots")
      .then(function (res) { return res.json(); })
      .then(function (body) {
        days = groupSlots(body.slots || []);
        if (!days.length) {
          pickerStatus.textContent = "Nothing is open in the next three weeks. Email info@planetek.org and we will find a time off the grid.";
          return;
        }
        pickerStatus.textContent = "";
        if (!selectedDay || !days.some(function (d) { return d.key === selectedDay; })) {
          selectedDay = days[0].key;
        }
        renderDays();
        renderTimes(days.filter(function (d) { return d.key === selectedDay; })[0]);
        form.hidden = false;
      })
      .catch(function () {
        pickerStatus.textContent = "The slot list did not load. Please email info@planetek.org with a few times that work and we will confirm one.";
      });
  }

  function resetSelection(message) {
    selectedSlot = null;
    readout.textContent = "No time selected yet.";
    setButton(false, "Pick a time above first");
    if (message) show("err", message);
    loadSlots();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!selectedSlot) { resetSelection("Pick a time first."); return; }
    if (!form.reportValidity()) return;

    var data = { slot: selectedSlot };
    new FormData(form).forEach(function (v, k) { data[k] = v; });

    setButton(false, "Booking…");

    fetch("/api/schedule/book", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok && body.ok) {
            picker.hidden = true;
            form.hidden = true;
            bookedWhen.textContent = "Booked for " + longFmt.format(new Date(selectedSlot)) +
              (sameTz ? "" : " (" + (body.when || "") + ")") + ".";
            if (body.confirmationEmailed) {
              document.getElementById("booked-note").textContent =
                "A confirmation with the calendar invite is on its way to your inbox, and the " +
                "booking just landed on our calendar. If anything changes, reply to that email " +
                "and we will move it, no forms required.";
            }
            if (body.ics) {
              icsLink.href = URL.createObjectURL(new Blob([body.ics], { type: "text/calendar" }));
            } else {
              icsLink.remove();
            }
            booked.style.display = "block";
            booked.scrollIntoView({ block: "center" });
          } else if (res.status === 409) {
            resetSelection("Someone just took that time. The list is refreshed, please pick another.");
          } else {
            show("err", (body.error || "Something went wrong.") +
              " You can also email info@planetek.org directly.");
            setButton(true, "Book this time");
          }
        });
      })
      .catch(function () {
        show("err", "Network error. Please email info@planetek.org directly.");
        setButton(true, "Book this time");
      });
  });

  loadSlots();
})();
