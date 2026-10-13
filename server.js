require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '10kb' }));

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

const bookingAttemptStore = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
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
        return res.status(429).json({ 
            error: 'Too many booking attempts from this network. Please try again after 15 minutes.' 
        });
    }

    record.count++;
    next();
function calculateTourPrice(tour, guests, guestCategory) {
    if (tour === 'Alicia Panoramic Park Tour') {
        const pax = parseInt(guests) || 1;
        if (pax > 5) {
            throw new Error('Alicia Panoramic Park Tour accommodates a maximum of 5 guests per booking.');
        }
        const baseFee = 500;
        let entranceFeePerPax = 50; // default Boholano
        if (guestCategory === 'outside_bohol') {
            entranceFeePerPax = 100;
        } else if (guestCategory === 'foreigner') {
            entranceFeePerPax = 150;
        }
        return baseFee + (pax * entranceFeePerPax);
    }

    if (tour === 'Lakeside Camp - The Campsite') {
        switch (String(guests)) {
            case '2_pax': case '2': return 750;
            case '4_pax': case '4': return 1050;
            case '6_vip_1': return 2750;
            case '6_vip_2': return 3050;
            case '7_pax': case '7': return 2250;
            case '8_pax': case '8': return 2050;
            case '10_pax': case '10': return 2250;
            default:
                const p = parseInt(guests) || 2;
                if (p === 2) return 750;
                if (p === 4) return 1050;
                if (p === 6) return 2750;
                if (p === 7) return 2250;
                if (p === 8) return 2050;
                if (p === 10) return 2250;
                throw new Error('Invalid Lakeside Camp tent package selection.');
        }
    }

    if (tour === 'Bohol Island Hopping') {
        const pax = parseInt(guests) || 1;
        if (pax <= 5) return 3500;
        if (pax <= 10) return 4000;
        if (pax <= 14) return 4500;
        if (pax <= 20) return 8500;
        if (pax <= 26) return 10500;
        throw new Error('Selected guest count exceeds maximum boat capacity.');
    }

    throw new Error('Invalid tour selection.');
}

app.post('/api/create-checkout-session', bookingRateLimiter, async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, tourTime, guests, guestCategory, secretKey, termsAccepted } = req.body;
        
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';

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
            amountPHP = calculateTourPrice(tour, guests, guestCategory);
        } catch (validationErr) {
            return res.status(400).json({ error: validationErr.message });
        }

        const amountCents = amountPHP * 100;
        const activeSecretKey = secretKey || process.env.PAYMONGO_SECRET_KEY;

        if (!activeSecretKey) {
            return res.status(500).json({ error: 'PayMongo secret key is not configured.' });
        }

        let formattedPhone = customerPhone;
        if (formattedPhone && formattedPhone.startsWith('0') && formattedPhone.length === 11) {
            formattedPhone = '+63' + formattedPhone.slice(1);
        }

        const authHeader = 'Basic ' + Buffer.from(activeSecretKey + ':').toString('base64');
        const domain = req.headers.host || 'localhost:3000';
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const successUrl = `${protocol}://${domain}/success.html`;
        const cancelUrl = `${protocol}://${domain}/index.html`;

        const itemDescription = tour === 'Lakeside Camp - The Campsite'
            ? `${tour} (${tourTime || '04:00 AM'}, Tent Package: ${guests})`
            : tour === 'Alicia Panoramic Park Tour' 
            ? `${tour} (${tourTime || '04:00 AM'}, ${guests} Guest${guests > 1 ? 's' : ''}, Residency: ${guestCategory || 'boholano'})` 
            : `${tour} (${tourTime || '04:00 AM'}, Tier: ${guests} Pax)`;

        const checkoutDescription = `Tour Date: ${bookingDate} • Time: ${tourTime || '04:00 AM'} • Contact: ${formattedPhone}`;

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
                    description: checkoutDescription,
                    metadata: {
                        customerName,
                        customerEmail,
                        customerPhone: formattedPhone,
                        bookingDate,
                        tourTime: tourTime || '04:00 AM',
                        guests: String(guests),
                        clientIp: clientIp
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
                                <li><strong>Package / Guests:</strong> ${guests}</li>
                                <li><strong>Phone Number:</strong> ${customerPhone}</li>
                                <li><strong>Total Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                            </ul>
                            <p>Please complete your payment through the secure PayMongo link.</p>
                            <p>Warm regards,<br><strong>TAPP Tours Team</strong></p>
                        </div>
                    `
                });

                await resend.emails.send({
                    from: senderEmail,
                    to: 'ferdinandctutor@gmail.com',
                    subject: `[New Booking Alert] ${tour} - ${customerName} (IP: ${clientIp})`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                            <h2 style="color: #12B76A;">New Booking Session Created</h2>
                            <ul>
                                <li><strong>Customer Name:</strong> ${customerName}</li>
                                <li><strong>Email:</strong> ${customerEmail}</li>
                                <li><strong>Phone:</strong> ${customerPhone}</li>
                                <li><strong>Tour:</strong> ${tour}</li>
                                <li><strong>Date:</strong> ${bookingDate}</li>
                                <li><strong>Time Slot:</strong> ${tourTime || '04:00 AM'}</li>
                                <li><strong>Package / Guests:</strong> ${guests}</li>
                                <li><strong>Total Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                                <li><strong>Client IP Address:</strong> ${clientIp}</li>
                            </ul>
                        </div>
                    `
                });
            } catch (notifyErr) {
                console.error('Email dispatch failed:', notifyErr.message);
            }

            return res.json({ checkoutUrl: data.data.attributes.checkout_url });
        } else {
            const errMsg = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to create PayMongo checkout session.';
            return res.status(400).json({ error: errMsg });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Internal server error.' });
    }
});

app.listen(PORT, () => {
    console.log(`TAPP Tours server running on port ${PORT}`);
});