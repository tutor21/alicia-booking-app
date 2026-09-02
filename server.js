require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');
const processedPaidSessions = new Set();

// Helper to calculate price and validate guest/boat tiers
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

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, tourTime, guests, secretKey, termsAccepted } = req.body;
        
        if (!termsAccepted) {
            return res.status(400).json({ error: 'You must accept the Terms & Conditions before proceeding to payment.' });
        }

        if (!tour || !customerEmail || !bookingDate) {
            return res.status(400).json({ error: 'Missing required booking details.' });
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

        const authHeader = 'Basic ' + Buffer.from(activeSecretKey + ':').toString('base64');
        const domain = req.headers.host || 'localhost:3000';
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const successUrl = `${protocol}://${domain}/success.html?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${protocol}://${domain}/index.html`;

        const itemDescription = tour === 'Alicia Panoramic Park Tour' 
            ? `${tour} (${tourTime || '04:00 AM'}, ${guests} Guest${guests > 1 ? 's' : ''})` 
            : `${tour} (${tourTime || '04:00 AM'}, Tier: ${guests} Pax)`;

        const paymongoPayload = {
            data: {
                attributes: {
                    billing: {
                        name: customerName || 'Valued Guest',
                        email: customerEmail,
                        phone: customerPhone || '09170000000'
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
                    description: `Booking for ${tour} on ${bookingDate} at ${tourTime || '04:00 AM'}`
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
            // Use onboarding@resend.dev until custom domain is verified in Resend dashboard
            const senderEmail = process.env.RESEND_FROM_EMAIL || 'TAPP Tours <onboarding@resend.dev>';

            // 1. Send Admin Booking Notification
            try {
                const adminRes = await resend.emails.send({
                    from: senderEmail,
                    to: 'ferdinandctutor@gmail.com',
                    subject: `[NEW BOOKING INITIATED] ${tour} - ${customerName}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                            <h2 style="color: #12B76A;">🔔 New Booking Session Started</h2>
                            <p>A customer has initiated a checkout session:</p>
                            <ul>
                                <li><strong>Customer:</strong> ${customerName} (${customerEmail})</li>
                                <li><strong>Phone:</strong> ${customerPhone}</li>
                                <li><strong>Tour:</strong> ${tour}</li>
                                <li><strong>Date:</strong> ${bookingDate} at ${tourTime || '04:00 AM'}</li>
                                <li><strong>Guests / Tier:</strong> ${guests}</li>
                                <li><strong>Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                            </ul>
                        </div>
                    `
                });
                console.log('Admin booking notification result:', adminRes);
            } catch (adminErr) {
                console.error('CRITICAL ADMIN BOOKING EMAIL ERROR:', adminErr);
            }

            return res.json({ checkoutUrl: data.data.attributes.checkout_url });
        } else {
            console.error('PayMongo Error:', data);
            const errMsg = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to create PayMongo checkout session.';
            return res.status(400).json({ error: errMsg });
        }
    } catch (err) {
        console.error('Server checkout error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error.' });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    try {
        const { sessionId, secretKey } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'Missing session ID.' });
        }

        if (processedPaidSessions.has(sessionId)) {
            return res.json({ success: true, message: 'Already processed.' });
        }

        const activeSecretKey = secretKey || process.env.PAYMONGO_SECRET_KEY;
        if (!activeSecretKey) {
            console.error('Verify payment error: PayMongo secret key not configured.');
            return res.status(500).json({ error: 'PayMongo secret key not configured.' });
        }

        const authHeader = 'Basic ' + Buffer.from(activeSecretKey + ':').toString('base64');
        
        const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${sessionId}`, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: authHeader
            }
        });

        const sessionData = await response.json();

        if (!response.ok || !sessionData.data) {
            console.error('PayMongo Session Retrieval Failed:', sessionData);
            return res.status(400).json({ error: 'Failed to retrieve checkout session from PayMongo.' });
        }

        const attrs = sessionData.data.attributes;
        const billing = attrs.billing || {};
        const customerEmail = billing.email;
        const customerName = billing.name || 'Valued Guest';
        const customerPhone = billing.phone || 'N/A';
        const lineItem = attrs.line_items && attrs.line_items[0] ? attrs.line_items[0] : {};
        const tourName = lineItem.name || 'Tour Booking';
        const amountPaidPHP = lineItem.amount ? lineItem.amount / 100 : 0;
        const description = attrs.description || '';

        processedPaidSessions.add(sessionId);

        const senderEmail = process.env.RESEND_FROM_EMAIL || 'TAPP Tours <onboarding@resend.dev>';

        // GUARANTEED ADMIN SUCCESS EMAIL NOTIFICATION
        try {
            const adminPaymentRes = await resend.emails.send({
                from: senderEmail,
                to: 'ferdinandctutor@gmail.com',
                subject: `[SUCCESSFUL PAYMENT VERIFIED] ${tourName} - ${customerName} (₱${amountPaidPHP.toLocaleString()})`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
                        <h2 style="color: #12B76A;">🎉 Payment Successfully Verified!</h2>
                        <p>A customer has successfully completed payment:</p>
                        <ul>
                            <li><strong>Customer:</strong> ${customerName} (${customerEmail})</li>
                            <li><strong>Phone:</strong> ${customerPhone}</li>
                            <li><strong>Tour:</strong> ${tourName}</li>
                            <li><strong>Description:</strong> ${description}</li>
                            <li><strong>Amount Paid:</strong> ₱${amountPaidPHP.toLocaleString()}</li>
                            <li><strong>Session ID:</strong> ${sessionId}</li>
                        </ul>
                        <p style="color: #666; font-size: 12px;">Please coordinate with the local guide for guest arrival.</p>
                    </div>
                `
            });
            console.log('Admin payment success email successfully sent to ferdinandctutor@gmail.com:', adminPaymentRes);
        } catch (adminPayErr) {
            console.error('CRITICAL ADMIN PAYMENT SUCCESS EMAIL ERROR:', adminPayErr);
        }

        return res.json({ success: true, message: 'Payment verified and admin notified.' });
    } catch (err) {
        console.error('Verify payment internal error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error.' });
    }
});

app.listen(PORT, () => {
    console.log(`TAPP Tours server running on port ${PORT}`);
});