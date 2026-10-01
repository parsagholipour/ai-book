// The public share page's viewer (apps/api/src/mobile/shares/sharePage.ts).
// pdf.js is vendored and served by the API: Android Chrome downloads a PDF
// rather than showing it, so this is the viewer, not a nicety. Pages render
// lazily as they near the screen and are released again far from it, which
// keeps a long book inside a phone's canvas memory.

const root = document.getElementById("share");

wireRemixLinks();
wireReport();
if (root && root.dataset.available === "true") {
  void openBook();
}

function wireRemixLinks() {
  // Android opens the app through an intent URL (Play Store when it is not
  // installed); every other browser keeps the plain Play Store link.
  if (!/Android/i.test(navigator.userAgent)) return;
  for (const link of document.querySelectorAll("a[data-intent]")) {
    link.setAttribute("href", link.dataset.intent);
  }
}

async function openBook() {
  const viewer = document.getElementById("viewer");
  const state = document.getElementById("viewer-state");
  const status = document.getElementById("viewer-status");
  const bar = state ? state.querySelector(".bar") : null;
  let pdfjs;
  try {
    pdfjs = await import("/s/_/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/s/_/pdfjs/pdf.worker.min.mjs";
  } catch {
    showState(state, "This book couldn't be opened in this browser.", true);
    return;
  }
  let pdf;
  try {
    const task = pdfjs.getDocument({ url: root.dataset.pdf, isEvalSupported: false, disableRange: true, disableStream: true });
    task.onProgress = ({ loaded, total }) => {
      if (!bar || !total) return;
      bar.dataset.progress = "true";
      bar.firstElementChild.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
      bar.firstElementChild.style.transform = "none";
      if (status) status.textContent = "Opening the book…";
    };
    pdf = await task.promise;
  } catch (error) {
    const updating = error && typeof error === "object" && "status" in error && error.status === 503;
    showState(
      state,
      updating ? "This book is being updated. Check back in a minute." : "This book couldn't be opened. Try again in a moment.",
      !updating
    );
    return;
  }

  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const holder = document.createElement("div");
    holder.className = "page";
    holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    holder.setAttribute("role", "img");
    holder.setAttribute("aria-label", `Page ${number} of ${pdf.numPages}`);
    pages.push({ page, holder, rendered: false, task: null });
    viewer.appendChild(holder);
  }
  state.remove();
  const privateEnd = document.getElementById("private-end");
  if (privateEnd) privateEnd.hidden = false;

  const render = async (entry) => {
    if (entry.rendered) return;
    entry.rendered = true;
    const width = entry.holder.clientWidth || viewer.clientWidth;
    const base = entry.page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = entry.page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    entry.holder.appendChild(canvas);
    entry.task = entry.page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
    try {
      await entry.task.promise;
    } catch {
      // A cancelled render is released below; anything else leaves a blank page.
    }
  };
  const release = (entry) => {
    if (!entry.rendered) return;
    entry.task?.cancel();
    entry.holder.replaceChildren();
    entry.rendered = false;
  };

  const near = new IntersectionObserver(
    (entries) => {
      for (const item of entries) {
        const entry = pages.find((candidate) => candidate.holder === item.target);
        if (!entry) continue;
        if (item.isIntersecting) void render(entry);
      }
    },
    { rootMargin: "150% 0px" }
  );
  const far = new IntersectionObserver(
    (entries) => {
      for (const item of entries) {
        const entry = pages.find((candidate) => candidate.holder === item.target);
        if (entry && !item.isIntersecting) release(entry);
      }
    },
    { rootMargin: "500% 0px" }
  );
  for (const entry of pages) {
    near.observe(entry.holder);
    far.observe(entry.holder);
  }
}

function showState(state, message, retry) {
  if (!state) return;
  state.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  state.appendChild(text);
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = "Try again";
    button.addEventListener("click", () => window.location.reload());
    state.appendChild(button);
  }
}

function wireReport() {
  const dialog = document.getElementById("report");
  const open = document.getElementById("report-open");
  const cancel = document.getElementById("report-cancel");
  const form = document.getElementById("report-form");
  const result = document.getElementById("report-result");
  const send = document.getElementById("report-send");
  if (!dialog || !open || !form || typeof dialog.showModal !== "function") {
    if (open) open.hidden = true;
    return;
  }
  open.addEventListener("click", () => {
    result.textContent = "";
    send.disabled = false;
    dialog.showModal();
  });
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    send.disabled = true;
    result.textContent = "Sending…";
    const data = new FormData(form);
    const comment = String(data.get("comment") || "").trim();
    try {
      const response = await fetch(root.dataset.report, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: String(data.get("reason")), ...(comment ? { comment } : {}) })
      });
      if (response.status === 201) {
        result.textContent = "Thanks. We'll take a look.";
        setTimeout(() => dialog.close(), 1500);
        return;
      }
      result.textContent =
        response.status === 429 ? "Too many reports from here. Try again later." : "That didn't go through. Try again.";
    } catch {
      result.textContent = "That didn't go through. Try again.";
    }
    send.disabled = false;
  });
}
