require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// SECURITY: Helmet HTTP Headers & Payload Limit
// ==========================================
app.use(helmet({
    contentSecurityPolicy: false, // Allows Tailwind CSS CDN and external assets to load properly
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '10kb' }));

// ==========================================
// SECURITY: Secure CORS Policy Configuration
// ==========================================
const allowedOrigins = [
    'https://aliciapanoramicpark.com',
    'https://www.aliciapanoramicpark.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS policy violation: Origin not allowed by TAPP Tours.'), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static('public'));

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

// ==========================================
// SECURITY: In-Memory Rate Limiter Middleware
// ==========================================
const bookingAttemptStore = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS_PER_WINDOW = 5;

function bookingRateLimiter(req, res, next) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
    const now = Date.now();

    if (!bookingAttemptStore.has(clientIp)) {
        bookingAttemptStore.set(clientIp, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
        return next();
    }

    const record = bookingAttemptStore.get(clientIp);

    if (now > record.resetTime) {
        record.count = 1;
        record.resetTime = now + RATE_LIMIT_WINDOW_MS;
        return next();
    }

    if (record.count >= MAX_ATTEMPTS_PER_WINDOW) {
        console.warn(`[SECURITY WARNING] Rate limit exceeded for IP address: ${clientIp}`);
        return res.status(429).json({ 
            error: 'Too many booking attempts from this network. For security reasons, please try again after 15 minutes.' 
        });
    }

    record.count++;
    next();
}

// Helper for strict email validation
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Helper to calculate price and validate guest/boat tiers based on tour selection
function calculateTourPrice(tour, guests) {
    const pax = parseInt(guests) || 1;

    if (tour === 'Alicia Panoramic Park Tour') {
        if (pax > 5) {
            throw new Error('Alicia Panoramic Park Tour accommodates a maximum of 5 guests per booking.');
        }
        return 750; // Flat rate for Alicia Panoramic Park (up to 5 pax)
    }

    if (tour === 'Bohol Island Hopping') {
        if (pax <= 5) return 3500;   // Small boat (1-5 pax)
        if (pax <= 10) return 4000;  // Small boat (6-10 pax)
        if (pax <= 14) return 4500;  // Small boat (11-14 pax)
        if (pax <= 20) return 8500;  // Medium boat (up to 20 pax)
        if (pax <= 26) return 10500; // Big boat (up to 26 pax)
        throw new Error('Selected guest count exceeds maximum boat capacity (up to 26 pax).');
    }

    throw new Error('Invalid tour selection.');
}

// Create PayMongo Checkout Session with Rate Limiting, IP Tracking & Email Notifications
app.post('/api/create-checkout-session', bookingRateLimiter, async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, tourTime, guests, secretKey, termsAccepted } = req.body;
        
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
        console.log(`[BOOKING ATTEMPT] Tour: ${tour}, Email: ${customerEmail}, Phone: ${customerPhone}, Client IP: ${clientIp}`);

        if (!termsAccepted) {
            return res.status(400).json({ error: 'You must accept the Terms & Conditions before proceeding to payment.' });
        }

        if (!tour || !customerEmail || !bookingDate || !customerName) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        if (!isValidEmail(customerEmail)) {
            return res.status(400).json({ error: 'Please provide a valid email address format.' });
        }

        if (!customerPhone || !/^\d{11}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'A valid 11-digit phone number is required.' });
        }

        let amountPHP;
        try {
            amountPHP = calculateTourPrice(tour, guests);
        } catch (validationErr) {
            return res.status(400).json({ error: validationErr.message });
        }

        const amountCents = amountPHP * 100;
        const activeSecretKey = secretKey || process.env.PAYMONGO_SECRET_KEY;

        if (!activeSecretKey) {
            return res.status(500).json({ error: 'PayMongo secret key is not configured.' });
        }

        // Format phone number to E.164 (+63...) for PayMongo compatibility
        let formattedPhone = customerPhone;
        if (formattedPhone && formattedPhone.startsWith('0') && formattedPhone.length === 11) {
            formattedPhone = '+63' + formattedPhone.slice(1);
        }

        const authHeader = 'Basic ' + Buffer.from(activeSecretKey + ':').toString('base64');
        const domain = req.headers.host || 'localhost:3000';
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const successUrl = `${protocol}://${domain}/success.html`;
        const cancelUrl = `${protocol}://${domain}/index.html`;

        const itemDescription = tour === 'Alicia Panoramic Park Tour' 
            ? `${tour} (${tourTime || '04:00 AM'}, ${guests} Guest${guests > 1 ? 's' : ''})` 
            : `${tour} (${tourTime || '04:00 AM'}, Tier: ${guests} Pax)`;

        const paymongoPayload = {
            data: {
                attributes: {
                    billing: {
                        name: customerName,
                        email: customerEmail,
                        phone: formattedPhone
                    },
                    line_items: [
                        {
                            amount: amountCents,
                            currency: 'PHP',
                            name: itemDescription,
                            quantity: 1
                        }
                    ],
                    payment_method_types: ['card', 'gcash', 'paymaya', 'qrph'],
                    success_url: successUrl,
                    cancel_url: cancelUrl,
                    description: `Booking for ${tour} on ${bookingDate} at ${tourTime || '04:00 AM'} (IP: ${clientIp})`,
                    metadata: {
                        customerName,
                        customerEmail,
                        customerPhone: formattedPhone,
                        bookingDate,
                        tourTime: tourTime || '04:00 AM',
                        guests: String(guests)
                    }
                }
            }
        };

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: authHeader
            },
            body: JSON.stringify(paymongoPayload)
        });

        const data = await response.json();

        if (response.ok && data.data && data.data.attributes && data.data.attributes.checkout_url) {
            try {
                const senderEmail = process.env.RESEND_FROM_EMAIL || 'TAPP Tours <onboarding@resend.dev>';

                // 1. Send confirmation email to customer
                await resend.emails.send({
                    from: senderEmail,
                    to: customerEmail,
                    subject: `Your Booking Reservation: ${tour}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                            <h2 style="color: #f4a261;">Booking Request Received!</h2>
                            <p>Hi <strong>${customerName}</strong>,</p>
                            <p>Thank you for booking with TAPP Tours. Here are your reservation details:</p>
                            <ul>
                                <li><strong>Tour:</strong> ${tour}</li>
                                <li><strong>Date:</strong> ${bookingDate}</li>
                                <li><strong>Time Slot:</strong> ${tourTime || '04:00 AM'}</li>
                                <li><strong>Guests / Boat Tier:</strong> ${guests}</li>
                                <li><strong>Phone Number:</strong> ${customerPhone}</li>
                                <li><strong>Total Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                            </ul>
                            <p>Please complete your payment through the secure PayMongo link.</p>
                            <p>Warm regards,<br><strong>TAPP Tours Team</strong></p>
                        </div>
                    `
                });

                // 2. Send notification email to admin
                await resend.emails.send({
                    from: senderEmail,
                    to: 'ferdinandctutor@gmail.com',
                    subject: `[New Booking Alert] ${tour} - ${customerName} (IP: ${clientIp})`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                            <h2 style="color: #12B76A;">New Booking Session Created</h2>
                            <p>A customer has initiated a checkout session:</p>
                            <ul>
                                <li><strong>Customer Name:</strong> ${customerName}</li>
                                <li><strong>Email:</strong> ${customerEmail}</li>
                                <li><strong>Phone:</strong> ${customerPhone}</li>
                                <li><strong>Tour:</strong> ${tour}</li>
                                <li><strong>Date:</strong> ${bookingDate}</li>
                                <li><strong>Time Slot:</strong> ${tourTime || '04:00 AM'}</li>
                                <li><strong>Guests / Boat Tier:</strong> ${guests}</li>
                                <li><strong>Total Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                                <li><strong>Client IP Address:</strong> ${clientIp}</li>
                            </ul>
                        </div>
                    `
                });

                console.log('[BOOKING EMAILS SENT SUCCESSFULLY]');
            } catch (notifyErr) {
                console.error('Email dispatch failed:', notifyErr.message);
            }

            return res.json({ checkoutUrl: data.data.attributes.checkout_url });
        } else {
            console.error('PayMongo Error:', data);
            const errMsg = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to create PayMongo checkout session.';
            return res.status(400).json({ error: errMsg });
        }
    } catch (err) {
        console.error('Server error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error.' });
    }
});

// Verify Payment Endpoint
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'Missing session ID.' });
        }

        const activeSecretKey = process.env.PAYMONGO_SECRET_KEY;
        if (!activeSecretKey) {
            return res.status(500).json({ success: false, error: 'PayMongo secret key is not configured.' });
        }

        const authHeader = 'Basic ' + Buffer.from(activeSecretKey + ':').toString('base64');
        const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${sessionId}`, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: authHeader }
        });

        const data = await response.json();

        if (response.ok && data.data) {
            const attr = data.data.attributes;
            const status = attr.status; 
            const payments = attr.payments || [];
            const isPaid = status === 'paid' || payments.some(p => p.attributes.status === 'paid');

            const customerName = attr.billing ? attr.billing.name : 'Guest';
            const customerEmail = attr.billing ? attr.billing.email : '';
            const customerPhone = attr.billing ? attr.billing.phone : '';
            const itemName = attr.line_items && attr.line_items[0] ? attr.line_items[0].name : 'Tour Booking';
            const amountPaid = attr.line_items && attr.line_items[0] ? attr.line_items[0].amount / 100 : 0;

            if (isPaid) {
                try {
                    const senderEmail = process.env.RESEND_FROM_EMAIL || 'TAPP Tours <onboarding@resend.dev>';

                    await resend.emails.send({
                        from: senderEmail,
                        to: 'ferdinandctutor@gmail.com',
                        subject: `[PAYMENT SUCCESSFUL] ${itemName} - ${customerName}`,
                        html: `
                            <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                                <h2 style="color: #12B76A;">PayMongo Payment Successfully Completed!</h2>
                                <p>A customer has successfully completed their payment:</p>
                                <ul>
                                    <li><strong>Customer Name:</strong> ${customerName}</li>
                                    <li><strong>Email:</strong> ${customerEmail}</li>
                                    <li><strong>Phone:</strong> ${customerPhone}</li>
                                    <li><strong>Item / Tour:</strong> ${itemName}</li>
                                    <li><strong>Amount Paid:</strong> ₱${amountPaid.toLocaleString()}</li>
                                    <li><strong>Session ID:</strong> ${sessionId}</li>
                                </ul>
                            </div>
                        `
                    });

                    console.log('[PAYMENT SUCCESS VERIFIED & ADMIN EMAIL SENT]');
                } catch (emailErr) {
                    console.error('Success notification error:', emailErr.message);
                }

                return res.json({ success: true, message: 'Payment verified successfully.' });
            } else {
                return res.json({ success: false, error: `Payment status is currently: ${status}` });
            }
        } else {
            return res.status(400).json({ success: false, error: 'Could not retrieve session from PayMongo.' });
        }
    } catch (err) {
        console.error('Server verification error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// PAYMONGO WEBHOOK ENDPOINT (With Signature Verification)
// ==========================================
app.post('/api/paymongo-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signatureHeader = req.headers['paymongo-signature'] || req.headers['Paymongo-Signature'];
        const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

        if (webhookSecret && signatureHeader) {
            const elements = signatureHeader.split(',');
            const timestamp = elements.find(el => el.startsWith('t='))?.split('=')[1];
            const liveSig = elements.find(el => el.startsWith('te='))?.split('=')[1] || elements.find(el => el.startsWith('li='))?.split('=')[1];

            const signedPayload = `${timestamp}.${req.body.toString()}`;
            const expectedSig = crypto
                .createHmac('sha256', webhookSecret)
                .update(signedPayload)
                .digest('hex');

            if (liveSig && expectedSig && liveSig !== expectedSig) {
                console.warn('[SECURITY WARNING] Invalid PayMongo webhook signature!');
                return res.status(400).json({ error: 'Invalid webhook signature.' });
            }
        }

        const event = JSON.parse(req.body.toString());
        
        if (event && event.data && event.data.attributes && event.data.attributes.type === 'checkout_session.payment.paid') {
            const sessionData = event.data.attributes.data;
            const billing = sessionData.attributes.billing || {};
            const customerName = billing.name || 'Valued Guest';
            const customerEmail = billing.email || '';
            const customerPhone = billing.phone || '';
            const lineItems = sessionData.attributes.line_items || [];
            const itemName = lineItems[0] ? lineItems[0].name : 'Tour Booking';
            const amountPaid = lineItems[0] ? lineItems[0].amount / 100 : 0;
            const sessionId = sessionData.id;

            console.log(`[PAYMONGO WEBHOOK] Payment confirmed for session: ${sessionId}`);

            const senderEmail = process.env.RESEND_FROM_EMAIL || 'TAPP Tours <onboarding@resend.dev>';

            await resend.emails.send({
                from: senderEmail,
                to: 'ferdinandctutor@gmail.com',
                subject: `[WEBHOOK SUCCESS] ${itemName} - ${customerName}`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                        <h2 style="color: #12B76A;">PayMongo Webhook Payment Confirmed!</h2>
                        <p>A webhook notification was received for a completed payment:</p>
                        <ul>
                            <li><strong>Customer Name:</strong> ${customerName}</li>
                            <li><strong>Email:</strong> ${customerEmail}</li>
                            <li><strong>Phone:</strong> ${customerPhone}</li>
                            <li><strong>Tour / Item:</strong> ${itemName}</li>
                            <li><strong>Amount Paid:</strong> ₱${amountPaid.toLocaleString()}</li>
                            <li><strong>Session ID:</strong> ${sessionId}</li>
                        </ul>
                    </div>
                `
            });

            console.log('[WEBHOOK ADMIN EMAIL SENT SUCCESSFULLY]');
        }

        return res.status(200).json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err.message);
        return res.status(400).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`TAPP Tours server running on port ${PORT} with Webhook Signature Verification, Email Notifications & E.164 Phone Formatting`);
});