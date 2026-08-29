const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Explicit Blog Routes
app.get('/blog-1', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-1.html'));
});

app.get('/blog-2', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-2.html'));
});

app.get('/blog-3', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-3.html'));
});

// Fee Calculation Helper Function
function calculatePayMongoTotal(subtotal, paymentMethod) {
    const RATES = {
        qrph: 0.0134, // 1.34%
        maya: 0.0179, // 1.79%
        card: 0.035   // standard estimate if applicable
    };

    const methodKey = paymentMethod ? paymentMethod.toLowerCase() : 'qrph';
    const feeRate = RATES[methodKey] || 0.0134;

    // Apply Gross-Up Formula: Subtotal / (1 - rate)
    const grandTotalPesos = subtotal / (1 - feeRate);
    const roundedPesos = Math.round(grandTotalPesos * 100) / 100;
    const amountInCentavos = Math.round(roundedPesos * 100);

    return {
        displayPrice: roundedPesos.toFixed(2),
        paymongoAmount: amountInCentavos
    };
}

// Create Checkout Session Endpoint
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;
        
        // Base price in pesos (₱750.00)
        const baseSubtotal = 750.00; 

        // Calculate total including PayMongo fee
        const calculation = calculatePayMongoTotal(baseSubtotal, 'qrph');

        const options = {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        line_items: [
                            {
                                currency: 'PHP',
                                amount: calculation.paymongoAmount,
                                name: `${tour} (${guests} Guest(s))`,
                                quantity: 1
                            }
                        ],
                        payment_method_types: ['card', 'gcash', 'qrph'],
                        success_url: 'https://' + req.get('host') + '/index.html?success=true',
                        cancel_url: 'https://' + req.get('host') + '/index.html',
                        description: `Booking date: ${bookingDate} | Customer: ${customerName} (${customerEmail})`
                    }
                }
            })
        };

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', options);
        const data = await response.json();

        if (response.ok && data.data) {
            res.json({ checkoutUrl: data.data.attributes.checkout_url });
        } else {
            const errorMsg = data.errors ? data.errors[0].detail : 'Checkout creation failed';
            res.status(400).json({ error: errorMsg });
        }
    } catch (err) {
        console.error('PayMongo Checkout Error:', err);
        res.status(500).json({ error: 'Server error connecting to payment gateway.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});