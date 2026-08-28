const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://aliciapanoramicpark.com';

// Middleware to parse JSON request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Price mapping (in PHP centavos: PHP * 100)
const TOUR_PRICES = {
    'Bohol Countryside Tour': 250000,     // ₱2,500
    'Alicia Panoramic Park': 50000,       // ₱500
    'Chocolate Hills Tour': 200000,       // ₱2,000
    'Island Hopping': 150000,             // ₱1,500
    'Private Tour with Maria Santos': 300000,
    'Private Tour with Juan Dela Cruz': 300000,
    'Private Tour with Pedro Garcia': 300000
};

// Checkout endpoint called by index.html
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        if (!tour || !customerEmail || !customerName) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        const unitAmount = TOUR_PRICES[tour] || 100000; // Default to ₱1,000 if tour price not found
        const totalAmount = unitAmount * (guests || 1);

        const secretKey = process.env.PAYMONGO_SECRET_KEY;
        if (!secretKey) {
            console.error('PAYMONGO_SECRET_KEY is missing from environment variables.');
            return res.status(500).json({ error: 'Server misconfiguration: PayMongo key is missing.' });
        }

        const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;

        // Create PayMongo Checkout Session
        const paymongoResponse = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        send_email_receipt: true,
                        show_description: true,
                        show_line_items: true,
                        line_items: [
                            {
                                currency: 'PHP',
                                amount: totalAmount,
                                description: `Booking for ${customerName} (${guests} guest(s) on ${bookingDate})`,
                                name: tour,
                                quantity: 1
                            }
                        ],
                        payment_method_types: ['gcash', 'paymaya', 'card', 'grab_pay', 'dob'],
                        success_url: `${APP_URL}/?status=success`,
                        cancel_url: `${APP_URL}/?status=cancelled`,
                        customer_email: customerEmail
                    }
                }
            })
        });

        const paymongoData = await paymongoResponse.json();

        if (!paymongoResponse.ok) {
            console.error('PayMongo API Error:', paymongoData);
            const errorMsg = paymongoData.errors?.[0]?.detail || 'Failed to generate checkout session.';
            return res.status(paymongoResponse.status).json({ error: errorMsg });
        }

        const checkoutUrl = paymongoData.data.attributes.checkout_url;
        return res.json({ checkoutUrl });

    } catch (err) {
        console.error('Server Checkout Error:', err);
        return res.status(500).json({ error: 'Internal server error. Check server logs.' });
    }
});

// Fallback to serve index.html for unknown routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bind server to process.env.PORT and 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Base APP_URL set to ${APP_URL}`);
});