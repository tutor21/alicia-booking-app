require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        // 1. Validate required fields
        if (!tour || !customerName || !customerEmail || !bookingDate || !guests) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        // 2. Pricing Logic: Flat ₱750 rate for up to 5 guests
        let amountInCents = 0;
        if (tour === "Alicia Panoramic Park Tour") {
            amountInCents = 75000; // ₱750.00 flat rate in centavos
        } else {
            return res.status(400).json({ error: "Invalid or currently unavailable tour selected." });
        }

        const paymongoSecretKey = process.env.PAYMONGO_SECRET_KEY;
        if (!paymongoSecretKey) {
            return res.status(500).json({ error: 'PayMongo secret key is not configured on the server.' });
        }

        const host = req.get('host');
        const protocol = req.protocol;

        // 3. Prepare the PayMongo Checkout Session payload
        const paymongoPayload = {
            data: {
                attributes: {
                    billing: {
                        name: customerName,
                        email: customerEmail,
                        phone: customerPhone || 'N/A'
                    },
                    send_email_receipt: true,
                    show_description: true,
                    show_line_items: true,
                    cancel_url: `${protocol}://${host}/index.html`,
                    success_url: `${protocol}://${host}/success.html?session_id={CHECKOUT_SESSION_ID}`,
                    description: `TAPP Tours - ${tour}`,
                    line_items: [
                        {
                            currency: 'PHP',
                            amount: amountInCents,
                            description: `Booking Date: ${bookingDate} | Group Size: ${guests} Guest(s)`,
                            name: tour,
                            quantity: 1
                        }
                    ],
                    // Enabled card, GCash, Maya, and QR Ph
                    payment_method_types: ['card', 'gcash', 'paymaya', 'qrph'],
                    metadata: {
                        customerName,
                        customerPhone: customerPhone || 'N/A',
                        bookingDate,
                        guests: guests.toString(),
                        tourName: tour
                    }
                }
            }
        };

        // 4. Authenticate and send request to PayMongo API
        const encodedKey = Buffer.from(`${paymongoSecretKey}:`).toString('base64');

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${encodedKey}`
            },
            body: JSON.stringify(paymongoPayload)
        });

        const data = await response.json();

        if (!response.ok || !data.data) {
            console.error("PayMongo Error:", data);
            const errorMessage = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to initiate PayMongo checkout session.';
            return res.status(500).json({ error: errorMessage });
        }

        const checkoutUrl = data.data.attributes.checkout_url;
        res.json({ checkoutUrl });

    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message || 'Internal server error while setting up payment.' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ TAPP Tours server is running on port ${PORT}`);
});