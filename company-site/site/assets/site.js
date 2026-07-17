// Contact form: same-origin POST to /api/contact (Lambda → SES → info@planetek.org).
(function () {
  var form = document.getElementById("contact-form");
  if (!form) return;
  var status = document.getElementById("form-status");
  var button = form.querySelector("button[type=submit]");

  function show(kind, msg) {
    status.className = kind;
    status.textContent = msg;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;

    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });

    button.disabled = true;
    button.textContent = "Sending…";

    fetch("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok && body.ok) {
            form.reset();
            show("ok", "Thanks — your message is on its way. We'll reply within 24 hours.");
          } else {
            show("err", (body.error || "Something went wrong.") +
              " You can also email info@planetek.org directly.");
          }
        });
      })
      .catch(function () {
        show("err", "Network error — please email info@planetek.org directly.");
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = "Send Message";
      });
  });
})();
