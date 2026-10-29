/* =====================================================================
   Sai Associates — Payment page logic
   Main: UPI apps + QR generator (existing logic + copy / download / share image)
   Optional panel: Payment gateway & receipt (Paytm JS Checkout + Apps Script),
   shown as "Coming soon" until gatewayLive is set to true in paymentpage.html
   Settings live in window.SA_PAYMENT_CONFIG (set in paymentpage.html).
   ===================================================================== */

/* ---------------------------------------------------------------------
   Shared helpers
   --------------------------------------------------------------------- */
const upiId = "paytmqr28100505010110zmr8sjesym@paytm"; // existing UPI ID (unchanged)

// Small toast message (existing helper, kept)
function displayMessage(message, type) {
    const messageContainer = document.createElement('div');
    messageContainer.setAttribute('role', 'status');
    messageContainer.style.cssText = `
        position: fixed;
        top: calc(var(--sa-nav-h, 66px) + 14px);
        left: 50%;
        transform: translateX(-50%);
        background-color: ${type === 'error' ? '#c53030' : '#038387'};
        color: white;
        padding: 10px 20px;
        border-radius: 999px;
        z-index: 2000;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        font-size: .9rem;
        max-width: calc(100vw - 32px);
        text-align: center;
        opacity: 0;
        transition: opacity 0.4s ease-in-out;
    `;
    messageContainer.textContent = message;
    document.body.appendChild(messageContainer);
    setTimeout(() => { messageContainer.style.opacity = 1; }, 10);
    setTimeout(() => {
        messageContainer.style.opacity = 0;
        messageContainer.addEventListener('transitionend', () => messageContainer.remove());
    }, 3000);
}

const SA_INR = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function saStore(key, value) {           // sessionStorage that never throws
    try {
        if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null');
        if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) { return null; }
}

/* ---------- Canvas drawing helpers (used for the QR image and the receipt) ---------- */
const SA_IMG = {
    teal: '#038387', tealDark: '#025a5d', ink: '#1f2b2b', muted: '#6c7a7a', line: '#e3eded', gold: '#cfae69',
    serif: '"Trajan Pro", Georgia, serif',
    sans: 'Montserrat, Arial, sans-serif'
};

let saLogoPromise = null;
function saLoadLogo() {
    if (!saLogoPromise) {
        saLogoPromise = new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);           // image still renders without the logo
            img.src = 'assets/sa-mark.png';
        });
    }
    return saLogoPromise;
}

async function saFontsReady() {
    try {
        await Promise.all([
            document.fonts.load('40px "Trajan Pro"'),
            document.fonts.load('400 20px Montserrat'),
            document.fonts.load('500 20px Montserrat')
        ]);
    } catch (e) { /* fall back to system fonts */ }
}

function saWrap(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    words.forEach((w) => {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
        else line = test;
    });
    if (line) lines.push(line);
    return lines;
}

function saRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function saSpacing(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }

function saDrawHeader(ctx, W, logo, title) {
    ctx.fillStyle = SA_IMG.teal; ctx.fillRect(0, 0, W, 96);
    ctx.fillStyle = SA_IMG.gold; ctx.fillRect(0, 96, W, 3);
    let x = 32;
    if (logo) {
        ctx.save(); saRoundRect(ctx, x, 22, 52, 52, 12); ctx.clip(); ctx.drawImage(logo, x, 22, 52, 52); ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.5; saRoundRect(ctx, x, 22, 52, 52, 12); ctx.stroke();
        x += 70;
    }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `30px ${SA_IMG.serif}`; saSpacing(ctx, 1); ctx.fillText('Sai Associates', x, 42);
    ctx.font = `400 14px ${SA_IMG.sans}`; saSpacing(ctx, 3); ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillText(title.toUpperCase(), x, 70);
    saSpacing(ctx, 0);
}

function saCanvasToBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image could not be created'))), 'image/png'));
}

function saDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function saSafeName(s) { return String(s || '').replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40); }

/* =====================================================================
   PAYMENT GATEWAY PANEL (folded by default, opens on click)
   ===================================================================== */
(function () {
    const toggle = document.getElementById('gwToggle');
    const body = document.getElementById('gwBody');
    if (!toggle || !body) return;
    function setOpen(open, scroll) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        body.hidden = !open;
        if (open && scroll) toggle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true', true));
    window.saOpenGateway = () => setOpen(true, false);
    if ((location.hash || '') === '#gateway') setOpen(true, true);
})();

/* =====================================================================
   UPI PAYMENT & QR GENERATOR (existing logic kept)
   ===================================================================== */
let saQr = null;   // { blob, amount, remark } for the image export

function generatePaymentLink(app) {
    const amount = document.getElementById("amount").value;
    const remark = document.getElementById("remark").value;
    const encodedRemark = encodeURIComponent(remark);

    if (!amount) {
        displayMessage("Please enter an amount to generate a payment link.", "error");
        return;
    }

    let paymentLink = "";

    if (app === 'gpay') {
        paymentLink = `gpay://upi/pay?pa=${upiId}&am=${amount}&tn=${encodedRemark}`;
    } else if (app === 'paytm') {
        paymentLink = `paytmmp://pay?pa=${upiId}&am=${amount}&tn=${encodedRemark}`;
    } else if (app === 'phonepe') {
        paymentLink = `phonepe://pay?pa=${upiId}&am=${amount}&tn=${encodedRemark}`;
    }

    if (paymentLink) {
        window.location.href = paymentLink;
    } else {
        displayMessage("Invalid payment app selected.", "error");
    }
}

function saSetQrTools(enabled) {
    document.querySelectorAll('[data-qr-tool]').forEach((b) => { b.disabled = !enabled; });
}

function generateQrCode() {
    const amount = document.getElementById("amount").value;
    const remark = document.getElementById("remark").value;
    const encodedRemark = encodeURIComponent(remark);

    const qrcodeDiv = document.getElementById("qrcode");
    saQr = null; saSetQrTools(false);
    qrcodeDiv.innerHTML = '<p class="loading-message">Generating QR Code...</p>'; // Show loading message

    if (!amount) {
        displayMessage("Please enter an amount to generate a QR code.", "error");
        saQrEmpty(); // Reset message
        return;
    }

    // UPI deep link for QR code
    const qrData = `upi://pay?pa=${upiId}&am=${amount}&tn=${encodedRemark}&cu=INR`;

    // Construct the API URL for QR code generation
    // Using goqr.me API for reliable QR code image generation
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrData)}`;

    // Clear previous content
    qrcodeDiv.innerHTML = '';

    // Create an image element
    const qrImage = document.createElement("img");
    qrImage.alt = "QR Code for Payment";
    qrImage.style.width = '256px';
    qrImage.style.height = '256px';
    qrImage.style.borderRadius = '5px';
    qrImage.style.boxShadow = '0 2px 5px rgba(0,0,0,0.1)';

    // Set a loading placeholder or message
    qrImage.src = "https://placehold.co/256x256/f0f0f0/cccccc?text=Loading+QR...";
    qrcodeDiv.appendChild(qrImage);

    // Add information below the QR code placeholder (same wording as before)
    const qrInfoParagraph = document.createElement("p");
    qrInfoParagraph.className = "qr-info";
    qrInfoParagraph.append(`Scan this QR code with your preferred UPI app to pay ₹${amount}.`, document.createElement('br'), `Remark: ${remark || 'N/A'}`);
    qrcodeDiv.appendChild(qrInfoParagraph);

    // Fetch the QR code image
    fetch(qrApiUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.blob(); // Get the image as a blob
        })
        .then(blob => {
            const objectURL = URL.createObjectURL(blob);
            qrImage.src = objectURL; // Set the image source to the generated QR code
            qrImage.onload = () => URL.revokeObjectURL(objectURL); // Clean up the object URL
            saQr = { blob, amount, remark };   // kept for Copy / Download
            saSetQrTools(true);
            const hint = document.getElementById('qrHint');
            if (hint) hint.textContent = 'Ready. Copy or download it to share with your client.';
        })
        .catch(error => {
            console.error("Error fetching QR code from API:", error);
            displayMessage("Failed to generate QR code. Please check your internet connection.", "error");
            qrImage.src = "https://placehold.co/256x256/ffcccc/cc0000?text=Error+Loading+QR"; // Show error image
            qrInfoParagraph.textContent = "Error: Could not generate QR code."; // Update info text
        });
}

function saQrEmpty() {
    document.getElementById('qrcode').innerHTML =
        '<p class="qr-info">Enter amount and remark, then click "Generate QR Code" to get your payment QR.</p>';
    const hint = document.getElementById('qrHint'); if (hint) hint.textContent = '';
}

/* Saves the QR box exactly as it has always looked (the area you used to crop):
   light grey box, 256px QR with soft shadow, the "Scan this QR code..." line and the remark.
   Drawn at the original box width (558px) and 2x resolution, so every image has the same format. */
async function saRenderQrImage() {
    if (!saQr) throw new Error('Generate a QR code first.');
    const qrBitmap = await createImageBitmap(saQr.blob);

    const W = 558, S = 2, BORDER = 1, PAD = 15, QR = 256;
    const FONT = '14.4px Arial, sans-serif', LINE = 21.6;        // 0.9em of 16px, line-height 1.5
    const inner = W - 2 * (BORDER + PAD);
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = FONT;
    const lines = []
        .concat(saWrap(measure, `Scan this QR code with your preferred UPI app to pay ₹${saQr.amount}.`, inner))
        .concat(saWrap(measure, `Remark: ${saQr.remark || 'N/A'}`, inner));
    const top = BORDER + PAD;
    const textTop = top + QR + 10;
    const H = Math.ceil(textTop + lines.length * LINE + 16 + PAD + BORDER);   // 16 = paragraph bottom margin

    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);

    // Page background, then the grey box with its light border
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    saRoundRect(ctx, .5, .5, W - 1, H - 1, 8);
    ctx.fillStyle = '#f9f9f9'; ctx.fill();
    ctx.strokeStyle = '#eee'; ctx.lineWidth = 1; ctx.stroke();

    // QR with rounded corners and the same soft shadow
    const qx = (W - QR) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.1)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
    saRoundRect(ctx, qx, top, QR, QR, 5); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
    ctx.save();
    saRoundRect(ctx, qx, top, QR, QR, 5); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qrBitmap, qx, top, QR, QR);
    ctx.restore();

    // Text lines, centred, grey
    ctx.fillStyle = '#666'; ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, textTop + i * LINE + LINE / 2));
    return canvas;
}

function saQrFileName() {
    const parts = ['SaiAssociates-UPI', 'Rs' + String(saQr.amount).replace(/[^\d.]/g, '')];
    if (saQr.remark) parts.push(saSafeName(saQr.remark));
    return parts.join('_') + '.png';
}

async function saCopyQrImage(btn) {
    if (!saQr) return displayMessage('Generate a QR code first.', 'error');
    const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border" aria-hidden="true"></span> Copying...';
    try {
        if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) throw new Error('unsupported');
        const blobPromise = saRenderQrImage().then(saCanvasToBlob);
        try {
            // Promise form keeps Safari happy (must be created inside the click)
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        } catch (e) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blobPromise })]);
        }
        displayMessage('QR image copied. Paste it into WhatsApp or email.', 'success');
    } catch (e) {
        // Browsers without image clipboard: save the file instead
        try {
            const blob = await saCanvasToBlob(await saRenderQrImage());
            saDownloadBlob(blob, saQrFileName());
            displayMessage("This browser can't copy images, so the image was downloaded instead.", 'success');
        } catch (err) { displayMessage(err.message || 'Could not create the image.', 'error'); }
    } finally {
        btn.innerHTML = original; btn.disabled = !saQr;
    }
}

async function saDownloadQrImage() {
    if (!saQr) return displayMessage('Generate a QR code first.', 'error');
    try {
        const blob = await saCanvasToBlob(await saRenderQrImage());
        saDownloadBlob(blob, saQrFileName());
    } catch (e) { displayMessage(e.message || 'Could not create the image.', 'error'); }
}

async function saShareQrImage() {
    if (!saQr) return;
    try {
        const blob = await saCanvasToBlob(await saRenderQrImage());
        const file = new File([blob], saQrFileName(), { type: 'image/png' });
        await navigator.share({ files: [file], title: 'Sai Associates payment QR', text: 'Payment of ₹' + SA_INR(saQr.amount) + (saQr.remark ? ' (' + saQr.remark + ')' : '') });
    } catch (e) { if (e && e.name !== 'AbortError') displayMessage('Sharing is not available here. Use Download instead.', 'error'); }
}

(function initQr() {
    const form = document.getElementById('paymentForm');
    if (!form) return;
    form.addEventListener('submit', (e) => { e.preventDefault(); generateQrCode(); });   // Enter key = Generate
    const copyBtn = document.getElementById('qrCopyBtn');
    copyBtn.addEventListener('click', () => saCopyQrImage(copyBtn));
    document.getElementById('qrDownloadBtn').addEventListener('click', saDownloadQrImage);
    const shareBtn = document.getElementById('qrShareBtn');
    try {
        const probe = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [probe] }) && window.matchMedia('(pointer: coarse)').matches) shareBtn.hidden = false;
    } catch (e) { /* share stays hidden */ }
    shareBtn.addEventListener('click', saShareQrImage);
    saSetQrTools(false);
    saQrEmpty();
})();

/* =====================================================================
   PAYMENT GATEWAY & RECEIPT (Paytm JS Checkout) — switched on with gatewayLive
   ===================================================================== */
(function initGateway() {
    const CFG = Object.assign({
        apiUrl: '',
        paytmHost: 'https://securestage.paytmpayments.com',
        maxAmount: 200000,
        merchantName: 'Sai Associates',
        gatewayLive: false
    }, window.SA_PAYMENT_CONFIG || {});
    // Payments start only when gatewayLive is true AND a real Apps Script URL is set
    const configured = CFG.gatewayLive === true && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(CFG.apiUrl || '');

    const form = document.getElementById('gatewayForm');
    if (!form) return;
    const payBtn = document.getElementById('gwPayBtn');
    const payLabel = document.getElementById('gwPayLabel');
    const alertBox = document.getElementById('gwAlert');
    const formView = document.getElementById('gatewayFormView');
    const receipt = document.getElementById('gatewayReceipt');
    const f = (id) => document.getElementById(id);

    let busy = false;
    let checkoutReady = null;          // promise for the Paytm script
    let checkoutLoadedOnce = false;
    let current = null;                // { orderId, name, purpose, email, mobile }
    let lastReceipt = null;

    /* ---------- UI helpers ---------- */
    function showAlert(msg, type) {
        alertBox.className = 'sa-alert show ' + (type === 'info' ? 'sa-alert--info' : 'sa-alert--error');
        alertBox.innerHTML = `<i class="fas ${type === 'info' ? 'fa-info-circle' : 'fa-exclamation-circle'} mt-1"></i><span></span>`;
        alertBox.querySelector('span').textContent = msg;
    }
    function hideAlert() { alertBox.className = 'sa-alert'; alertBox.textContent = ''; }
    function setBusy(on, text) {
        busy = on;
        if (!configured && !on) {                       // not live yet
            payBtn.disabled = true;
            payBtn.innerHTML = '<i class="far fa-clock"></i> <span id="gwPayLabel">Coming soon</span>';
            return;
        }
        payBtn.disabled = on;
        payBtn.innerHTML = on
            ? `<span class="spinner-border" aria-hidden="true"></span> ${text || 'Please wait...'}`
            : `<i class="fas fa-lock"></i> <span id="gwPayLabel">${payLabelText()}</span>`;
    }
    function payLabelText() {
        const v = parseFloat(f('gwAmount').value);
        return v > 0 ? `Pay ₹${SA_INR(v)} securely` : 'Proceed to secure payment';
    }
    f('gwAmount').addEventListener('input', () => { if (!busy && configured) { const l = document.getElementById('gwPayLabel'); if (l) l.textContent = payLabelText(); } });
    f('gwClientRef').addEventListener('input', (e) => { const p = e.target.selectionStart; e.target.value = e.target.value.toUpperCase(); e.target.setSelectionRange(p, p); });
    f('gwMobile').addEventListener('input', (e) => {
        // Accepts pasted numbers like "+91 98765 43210" or "098765-43210"
        let d = e.target.value.replace(/\D/g, '');
        if (d.length > 10 && /^(91|0)/.test(d)) d = d.replace(/^(91|0)/, '');
        e.target.value = d.slice(0, 10);
    });

    if (!configured) {
        showAlert('Coming soon. Online payment with an instant receipt is being tested. Until then, please pay by UPI above.', 'info');
        setBusy(false);
    }

    /* ---------- Validation ---------- */
    function validate() {
        const amount = parseFloat(f('gwAmount').value);
        const checks = [
            ['gwName', (v) => v.trim().length >= 2, 'Please enter your full name.'],
            ['gwMobile', (v) => /^[6-9]\d{9}$/.test(v.trim()), 'Enter a valid 10-digit mobile number.'],
            ['gwEmail', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()), 'Enter a valid email address.'],
            ['gwPurpose', (v) => !!v, 'Please choose what this payment is for.'],
            ['gwAmount', () => amount >= 1 && amount <= CFG.maxAmount && /^\d+(\.\d{1,2})?$/.test(f('gwAmount').value.trim()),
                `Enter an amount between ₹1 and ₹${SA_INR(CFG.maxAmount)}.`],
            ['gwConsent', () => f('gwConsent').checked, 'Please confirm your details.']
        ];
        let firstBad = null;
        checks.forEach(([id, test, msg]) => {
            const el = f(id);
            const ok = test(el.type === 'checkbox' ? '' : el.value);
            el.classList.toggle('is-invalid', !ok);
            const fb = el.closest('.sa-field') && el.closest('.sa-field').querySelector('.invalid-feedback');
            if (fb) fb.textContent = msg;
            if (!ok && !firstBad) firstBad = el;
        });
        if (firstBad) firstBad.focus();
        return !firstBad;
    }
    form.querySelectorAll('input, select').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => el.classList.remove('is-invalid')));

    /* ---------- Backend (Google Apps Script web app) ---------- */
    async function callApi(payload) {
        const res = await fetch(CFG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // simple request: no CORS pre-flight
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Server error (' + res.status + ')');
        let json = await res.json();
        if (json && json.status === 'error') throw new Error(json.message || 'Request failed');
        if (json && json.success === undefined && json.data && typeof json.data === 'object') json = json.data;
        return json;
    }

    /* ---------- Paytm checkout script ---------- */
    function loadCheckout(host, mid) {
        if (checkoutReady) return checkoutReady;
        checkoutReady = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = `${host.replace(/\/$/, '')}/merchantpgpui/checkoutjs/merchants/${encodeURIComponent(mid)}.js`;
            s.crossOrigin = 'anonymous';
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => { checkoutReady = null; reject(new Error('Could not load the Paytm payment window. Please check your connection and try again.')); };
            document.head.appendChild(s);
        });
        return checkoutReady;
    }

    function openCheckout(order) {
        const config = {
            root: '',
            flow: 'DEFAULT',
            data: {
                orderId: order.orderId,
                token: order.txnToken,
                tokenType: 'TXN_TOKEN',
                amount: order.amount
            },
            merchant: {
                name: CFG.merchantName,
                logo: new URL('assets/sa-mark.png', location.href).href,
                redirect: false                       // result comes back to transactionStatus below
            },
            handler: {
                notifyMerchant: function (eventName) {
                    if (eventName === 'APP_CLOSED') onCheckoutClosed();
                },
                transactionStatus: function () {
                    // Never trust the browser result on its own: confirm with the server
                    try { window.Paytm.CheckoutJS.close(); } catch (e) {}
                    verify(order.orderId, true);
                }
            }
        };
        return new Promise((resolve, reject) => {
            const start = () => window.Paytm.CheckoutJS.init(config)
                .then(() => { window.Paytm.CheckoutJS.invoke(); resolve(); })
                .catch(reject);
            if (!window.Paytm || !window.Paytm.CheckoutJS) return reject(new Error('Payment window unavailable.'));
            if (checkoutLoadedOnce) start();
            else { checkoutLoadedOnce = true; window.Paytm.CheckoutJS.onLoad(start); }
        });
    }

    /* ---------- Submit ---------- */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        hideAlert();
        if (!validate()) return;
        if (!configured) {
            showAlert('Coming soon. Please pay by UPI above for now.', 'info');
            return;
        }
        const amount = parseFloat(f('gwAmount').value).toFixed(2);
        const details = {
            name: f('gwName').value.trim(),
            mobile: f('gwMobile').value.trim(),
            email: f('gwEmail').value.trim(),
            clientRef: f('gwClientRef').value.trim(),
            purpose: f('gwPurpose').value,
            remark: f('gwRemark').value.trim(),
            amount
        };
        setBusy(true, 'Creating secure order...');
        try {
            const res = await callApi(Object.assign({ action: 'initiatePayment', returnUrl: location.origin + location.pathname }, details));
            if (!res || !res.success || !res.txnToken || !res.orderId || !res.mid) {
                throw new Error((res && res.message) || 'We could not start the payment. Please try again.');
            }
            current = { orderId: res.orderId, name: details.name, purpose: details.purpose, email: details.email };
            saStore('saPayLastOrder', current);
            setBusy(true, 'Opening payment window...');
            await loadCheckout(res.host || CFG.paytmHost, res.mid);
            await openCheckout({ orderId: res.orderId, txnToken: res.txnToken, amount: res.amount || amount });
            setBusy(true, 'Complete the payment in the Paytm window...');
        } catch (err) {
            setBusy(false);
            showAlert(err.message || 'Something went wrong. Please try again.');
        }
    });

    function onCheckoutClosed() {
        // The window was closed. The payment may still have gone through (e.g. UPI app), so check quietly.
        if (!current) { setBusy(false); return; }
        setBusy(true, 'Checking payment status...');
        callApi({ action: 'verifyPayment', orderId: current.orderId })
            .then((r) => {
                if (r && r.success && r.status === 'TXN_SUCCESS') return renderReceipt('success', r);
                if (r && r.success && r.status === 'PENDING') return renderReceipt('pending', r);
                setBusy(false);
                showAlert('Payment was not completed. No receipt has been generated. You can try again.', 'info');
            })
            .catch(() => { setBusy(false); showAlert('Payment window closed. If money was debited, it will be confirmed shortly.', 'info'); });
    }

    /* ---------- Verify & receipt ---------- */
    async function verify(orderId, fromCheckout) {
        renderReceipt('checking', { orderId });
        try {
            const r = await callApi({ action: 'verifyPayment', orderId });
            if (!r || !r.success) throw new Error((r && r.message) || 'Could not confirm the payment yet.');
            const state = r.status === 'TXN_SUCCESS' ? 'success' : (r.status === 'PENDING' ? 'pending' : 'failed');
            renderReceipt(state, r);
        } catch (e) {
            renderReceipt('pending', { orderId, message: fromCheckout
                ? 'We are waiting for confirmation from the bank. Please check again in a minute.'
                : (e.message || 'Could not confirm the payment yet.') });
        }
    }

    const STATES = {
        checking: { icon: 'fa-circle-notch fa-spin', title: 'Confirming your payment', msg: 'Please wait a moment and do not close this page.' },
        success: { icon: 'fa-check', title: 'Payment successful', msg: 'Thank you. Your receipt is below.' },
        pending: { icon: 'fa-hourglass-half', title: 'Payment pending', msg: 'Your bank has not confirmed this payment yet. Please check again shortly.' },
        failed: { icon: 'fa-times', title: 'Payment failed', msg: 'No money was taken. If it was debited, it is usually refunded by your bank automatically.' }
    };

    function renderReceipt(state, r) {
        const st = STATES[state];
        const saved = saStore('saPayLastOrder') || {};
        const data = {
            orderId: r.orderId || (current && current.orderId) || saved.orderId || '',
            txnId: r.txnId || '',
            bankTxnId: r.bankTxnId || '',
            amount: r.amount || '',
            name: r.name || (current && current.name) || saved.name || '',
            purpose: r.purpose || (current && current.purpose) || saved.purpose || '',
            mode: r.paymentMode || '',
            date: r.txnDate || ''
        };
        lastReceipt = Object.assign({ state }, data);
        if (state !== 'checking') setBusy(false);
        formView.hidden = true;
        receipt.hidden = false;
        receipt.dataset.state = state;
        receipt.querySelector('.sa-receipt-ico').innerHTML = `<i class="fas ${st.icon}"></i>`;
        receipt.querySelector('h2').textContent = st.title;
        receipt.querySelector('.sa-receipt-msg').textContent = r.message && state !== 'success' ? r.message : st.msg;
        receipt.querySelector('.sa-receipt-amount').textContent = data.amount ? '₹ ' + SA_INR(data.amount) : '';

        const rows = [
            ['Receipt / Order ID', data.orderId],
            ['Transaction ID', data.txnId],
            ['Bank reference', data.bankTxnId],
            ['Paid by', data.name],
            ['Payment for', data.purpose],
            ['Payment mode', data.mode],
            ['Date & time', data.date]
        ].filter((x) => x[1]);
        const dl = receipt.querySelector('.sa-receipt-table');
        dl.innerHTML = '';
        rows.forEach(([k, v]) => {
            const row = document.createElement('div');
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = v;
            row.append(dt, dd); dl.appendChild(row);
        });
        dl.hidden = state === 'checking';

        receipt.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(state); });
        if (state === 'success') saStore('saPayLastOrder', null);
        receipt.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* Receipt as a PNG (same style as the QR card) */
    async function receiptImage() {
        const d = lastReceipt; if (!d) throw new Error('No receipt yet.');
        await saFontsReady();
        const logo = await saLoadLogo();
        const W = 620, S = 2, PAD = 44;
        const rows = [['Receipt / Order ID', d.orderId], ['Transaction ID', d.txnId], ['Bank reference', d.bankTxnId],
            ['Paid by', d.name], ['Payment for', d.purpose], ['Payment mode', d.mode], ['Date & time', d.date]].filter((x) => x[1]);
        const H = 99 + 50 + 40 + 64 + 6 + rows.length * 46 + 30 + 80;
        const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
        const ctx = c.getContext('2d'); ctx.scale(S, S);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        saDrawHeader(ctx, W, logo, 'Payment Receipt');

        let y = 99 + 50;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const ok = d.state === 'success';
        ctx.fillStyle = ok ? '#1f8a4c' : '#b7791f'; ctx.font = `500 15px ${SA_IMG.sans}`; saSpacing(ctx, 3);
        ctx.fillText(ok ? 'PAYMENT SUCCESSFUL' : 'PAYMENT ' + String(d.state).toUpperCase(), W / 2, y); saSpacing(ctx, 0);
        y += 40;
        ctx.fillStyle = SA_IMG.ink; ctx.font = `46px ${SA_IMG.serif}`;
        ctx.fillText(d.amount ? '₹ ' + SA_INR(d.amount) : '', W / 2, y + 16);
        y += 64 + 6;

        ctx.strokeStyle = SA_IMG.line; ctx.setLineDash([6, 6]);
        rows.forEach(([k, v]) => {
            ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
            ctx.textAlign = 'left'; ctx.fillStyle = SA_IMG.muted; ctx.font = `400 15px ${SA_IMG.sans}`; ctx.fillText(k, PAD, y + 23);
            ctx.textAlign = 'right'; ctx.fillStyle = SA_IMG.ink; ctx.font = `500 15px ${SA_IMG.sans}`;
            let val = String(v); while (ctx.measureText(val).width > W - PAD * 2 - 190 && val.length > 4) val = val.slice(0, -2);
            ctx.fillText(val === String(v) ? val : val + '…', W - PAD, y + 23);
            y += 46;
        });
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke(); ctx.setLineDash([]);
        y += 30;
        ctx.textAlign = 'center'; ctx.fillStyle = '#8a9898'; ctx.font = `400 13px ${SA_IMG.sans}`;
        ctx.fillText('This is a computer-generated receipt and needs no signature.', W / 2, y + 8);
        ctx.fillText('Payment processed securely via Paytm Payment Gateway.', W / 2, y + 30);
        return c;
    }

    receipt.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]'); if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'download') {
            try { saDownloadBlob(await saCanvasToBlob(await receiptImage()), `SaiAssociates-Receipt_${saSafeName(lastReceipt.orderId)}.png`); }
            catch (err) { displayMessage(err.message || 'Could not create the receipt image.', 'error'); }
        } else if (act === 'print') {
            window.print();
        } else if (act === 'recheck') {
            verify(lastReceipt && lastReceipt.orderId);
        } else if (act === 'new') {
            receipt.hidden = true; formView.hidden = false; current = null; setBusy(false); hideAlert();
            if (lastReceipt && lastReceipt.state === 'success') { form.reset(); setBusy(false); }
            formView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });

    /* ---------- Returning from Paytm's callback page: paymentpage?orderId=... ---------- */
    const params = new URLSearchParams(location.search);
    const returning = params.get('orderId');
    if (returning && configured) {
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
        if (window.saOpenGateway) window.saOpenGateway();
        verify(returning);
    }
})();
