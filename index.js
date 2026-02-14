const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin Setup
if (!admin.apps.length) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8");
    const serviceAccount = JSON.parse(decoded);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ms110.97wej2n.mongodb.net/?appName=ms110`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let db, usersCollection, contestsCollection, participantsCollection, paymentsCollection;

// Database Connection Helper
async function connectDB() {
    if (!db) {
        await client.connect();
        db = client.db("contestHubDB");
        usersCollection = db.collection("users");
        contestsCollection = db.collection("contests");
        participantsCollection = db.collection("participants");
        paymentsCollection = db.collection("payments");
        console.log("Connected to MongoDB!");
    }
}

// Middleware to ensure DB connection
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        res.status(500).send({ message: "Database connection failed" });
    }
});

// Auth Middlewares
const verifyToken = async (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) return res.status(401).send({ message: "Unauthorized access" });

    const token = authorization.split(" ")[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
    } catch (error) {
        return res.status(401).send({ message: "Invalid Token" });
    }
};

const verifyAdmin = async (req, res, next) => {
    const email = req.decoded.email;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== "admin") return res.status(403).send({ message: "Forbidden access" });
    next();
};

const verifyCreator = async (req, res, next) => {
    const email = req.decoded.email;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== "creator" && user?.role !== "admin") return res.status(403).send({ message: "Forbidden access" });
    next();
};

// --- ROUTES ---

// Root Route
app.get("/", (req, res) => {
    res.send("ContestHub API is running!");
});

// User Routes
app.post("/users", async (req, res) => {
    const user = req.body;
    const existingUser = await usersCollection.findOne({ email: user.email });
    if (existingUser) return res.send({ message: "User already exists", insertedId: null });

    user.role = "user";
    user.createdAt = new Date();
    const result = await usersCollection.insertOne(user);
    res.send(result);
});

app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
    const searchText = req.query.searchText || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const query = searchText ? {
        $or: [
            { displayName: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } },
        ],
    } : {};
    const total = await usersCollection.countDocuments(query);
    const users = await usersCollection.find(query).skip((page - 1) * limit).limit(limit).toArray();
    res.send({ users, totalPages: Math.ceil(total / limit), totalUsers: total });
});

app.get("/users/:email/role", verifyToken, async (req, res) => {
    const user = await usersCollection.findOne({ email: req.params.email });
    res.send({ role: user?.role || "user" });
});

// Contest Routes
app.get("/contests", async (req, res) => {
    const { type, search } = req.query;
    let query = { status: "approved" };
    if (type && type !== "all") query.type = type;
    if (search) query.name = { $regex: search, $options: "i" };
    const result = await contestsCollection.find(query).toArray();
    res.send(result);
});

app.get("/contests/popular", async (req, res) => {
    const result = await contestsCollection.find({ status: "approved" }).sort({ participantsCount: -1 }).limit(6).toArray();
    res.send(result);
});

app.get("/contests/:id", async (req, res) => {
    const result = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});

app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
    const contest = req.body;
    contest.status = "pending";
    contest.participantsCount = 0;
    contest.createdAt = new Date();
    const result = await contestsCollection.insertOne(contest);
    res.send(result);
});

// Payment Routes
app.post("/create-payment-intent", verifyToken, async (req, res) => {
    const { contestId, contestName, price, userEmail, userName, userPhoto } = req.body;
    const existing = await participantsCollection.findOne({ contestId, userEmail });
    if (existing) return res.status(400).send({ message: "Already registered" });

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [{
                price_data: {
                    currency: "usd",
                    product_data: { name: contestName },
                    unit_amount: Math.round(price * 100),
                },
                quantity: 1,
            }],
            mode: "payment",
            success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&contestId=${contestId}`,
            cancel_url: `${process.env.CLIENT_URL}/contest/${contestId}?payment=cancelled`,
            metadata: { contestId, contestName, userEmail, userName, userPhoto: userPhoto || "" },
        });
        res.send({ sessionId: session.id, url: session.url });
    } catch (error) {
        res.status(500).send({ message: "Payment initialization failed" });
    }
});

// Leaderboard
app.get("/leaderboard", async (req, res) => {
    try {
        const winners = await participantsCollection.find({ isWinner: true }).toArray();
        const leaderboardMap = {};
        for (const winner of winners) {
            const contest = await contestsCollection.findOne({ _id: new ObjectId(winner.contestId) }, { projection: { prizeMoney: 1 } });
            const prize = parseInt(contest?.prizeMoney) || 0;
            if (leaderboardMap[winner.userEmail]) {
                leaderboardMap[winner.userEmail].winCount += 1;
                leaderboardMap[winner.userEmail].totalPrize += prize;
            } else {
                leaderboardMap[winner.userEmail] = {
                    userName: winner.userName,
                    userPhoto: winner.userPhoto,
                    winCount: 1,
                    totalPrize: prize,
                };
            }
        }
        const result = Object.values(leaderboardMap).sort((a, b) => b.winCount - a.winCount).slice(0, 20);
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Failed to fetch leaderboard" });
    }
});

// Start Server (local environment)
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}

// Vercel export
module.exports = app;