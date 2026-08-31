require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

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

// Create PayMongo Checkout Session
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

        const amountCents = amountPHP * 100; // PayMongo expects centavos
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
            // Send confirmation email via Resend using payments@aliciapanoramicpark.com
            try {
                await resend.emails.send({
                    from: process.env.RESEND_FROM_EMAIL || 'TAPP Tours <payments@aliciapanoramicpark.com>',
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
                                <li><strong>Total Amount:</strong> ₱${amountPHP.toLocaleString()}</li>
                            </ul>
                            <p>Please complete your payment through the secure link provided at checkout.</p>
                            <p>Warm regards,<br><strong>TAPP Tours Team</strong></p>
                        </div>
                    `
                });
            } catch (emailErr) {
                console.error('Email sending failed:', emailErr.message);
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

app.listen(PORT, () => {
    console.log(`TAPP Tours server running on port ${PORT}`);
});