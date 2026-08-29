const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://aliciapanoramicpark.com';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Tour prices in centavos (₱750 = 75000 centavos)
const TOUR_PRICES = {
    'Alicia Panoramic Park Tour': 75000,
    'Private Tour with Maria Santos': 300000,
    'Private Tour with Juan Dela Cruz': 300000,
    'Private Tour with Pedro Garcia': 300000
};

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        if (!tour || !customerEmail || !customerName) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        const guestCount = parseInt(guests) || 1;

        // Enforce maximum 5 guests for Alicia Panoramic Park Tour
        if (tour === 'Alicia Panoramic Park Tour' && guestCount > 5) {
            return res.status(400).json({ error: 'Alicia Panoramic Park Tour accepts a maximum of 5 guests per booking.' });
        }

        // Flat price per tour booking
        const totalAmount = TOUR_PRICES[tour] || 75000;

        const secretKey = process.env.PAYMONGO_SECRET_KEY;
        if (!secretKey) {
            return res.status(500).json({ error: 'Server misconfiguration: PayMongo key missing.' });
        }

        const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;

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
                                description: `Booking for ${customerName} (${guestCount} guest(s) on ${bookingDate})`,
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
            const errorMsg = paymongoData.errors?.[0]?.detail || 'Failed to generate checkout session.';
            return res.status(paymongoResponse.status).json({ error: errorMsg });
        }

        return res.json({ checkoutUrl: paymongoData.data.attributes.checkout_url });

    } catch (err) {
        console.error('Server Checkout Error:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});