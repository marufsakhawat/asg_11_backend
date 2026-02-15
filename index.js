const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

/** * FIREBASE ADMIN SDK SETUP 
 * Initializes Firebase Admin using a Base64 encoded Service Account Key from .env
 */
if (!admin.apps.length) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8");
    const serviceAccount = JSON.parse(decoded);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

/**
 * MIDDLEWARE 
 */
app.use(cors());
app.use(express.json());

/**
 * MONGODB CONFIGURATION
 */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ms110.97wej2n.mongodb.net/?appName=ms110`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let db, usersCollection, contestsCollection, participantsCollection, paymentsCollection;

/**
 * DATABASE CONNECTION HELPER
 */
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

/**
 * GLOBAL DATABASE CONNECTION MIDDLEWARE
 */
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        res.status(500).send({ message: "Database connection failed" });
    }
});

/**
 * AUTHENTICATION MIDDLEWARES
 */

// Verify Firebase ID Token
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

// Verify if user is Admin
const verifyAdmin = async (req, res, next) => {
    const email = req.decoded.email;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== "admin") return res.status(403).send({ message: "Forbidden access" });
    next();
};

// Verify if user is Creator or Admin
const verifyCreator = async (req, res, next) => {
    const email = req.decoded.email;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== "creator" && user?.role !== "admin") return res.status(403).send({ message: "Forbidden access" });
    next();
};

/**
 * --- ROUTES ---
 */

app.get("/", (req, res) => {
    res.send("ContestHub API is running!");
});

// User Onboarding
app.post("/users", async (req, res) => {
    const user = req.body;
    const existingUser = await usersCollection.findOne({ email: user.email });
    if (existingUser) return res.send({ message: "User already exists", insertedId: null });

    user.role = "user";
    user.createdAt = new Date();
    const result = await usersCollection.insertOne(user);
    res.send(result);
});

// Admin: Get all users
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

// Public Contest Routes
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

// Creator: Add a new contest
app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
    const contest = req.body;
    contest.status = "pending";
    contest.participantsCount = 0;
    contest.createdAt = new Date();
    const result = await contestsCollection.insertOne(contest);
    res.send(result);
});

/**
 * CONTEST UPDATE & DELETE (Unified for Admin & Creator)
 */

// Unified Delete: Admin can delete anything, Creator can delete only their own
app.delete("/contests/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        const decodedEmail = req.decoded.email.toLowerCase();
        const query = { _id: new ObjectId(id) };
        
        const contest = await contestsCollection.findOne(query);
        if (!contest) return res.status(404).send({ message: "Contest not found" });

        const user = await usersCollection.findOne({ email: decodedEmail });
        const isAdmin = user?.role === "admin";
        const isOwner = contest.creatorEmail?.toLowerCase() === decodedEmail;

        if (!isAdmin && !isOwner) {
            return res.status(403).send({ message: "Unauthorized: You don't have permission to delete this." });
        }

        const result = await contestsCollection.deleteOne(query);
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Delete failed" });
    }
});

// Creator: Update their own contest
app.patch("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
    try {
        const id = req.params.id;
        const decodedEmail = req.decoded.email.toLowerCase();
        const filter = { _id: new ObjectId(id) };

        const contest = await contestsCollection.findOne(filter);
        if (!contest) return res.status(404).send({ message: "Contest not found" });

        if (contest.creatorEmail?.toLowerCase() !== decodedEmail) {
            return res.status(403).send({ message: "You can only update your own contests" });
        }

        const updatedDoc = { $set: req.body };
        const result = await contestsCollection.updateOne(filter, updatedDoc);
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Update failed" });
    }
});

// Stripe Payment
app.post("/create-payment-intent", verifyToken, async (req, res) => {
    const { contestId, contestName, price, userEmail, userName, userPhoto } = req.body;
    const existing = await participantsCollection.findOne({ contestId, userEmail });
    if (existing) return res.status(400).send({ message: "Already registered" });

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            customer_email: userEmail,
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

// Public: Stats & Leaderboard
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

app.get("/stats", async (req, res) => {
    const totalContests = await contestsCollection.countDocuments({ status: "approved" });
    const totalParticipants = await participantsCollection.countDocuments();
    const totalWinners = await participantsCollection.countDocuments({ isWinner: true });
    const prizePipeline = [{ $match: { winnerEmail: { $exists: true } } }, { $group: { _id: null, totalPrize: { $sum: "$prizeMoney" } } }];
    const prizeResult = await contestsCollection.aggregate(prizePipeline).toArray();
    res.send({ totalContests, totalParticipants, totalWinners, totalPrizeMoney: prizeResult[0]?.totalPrize || 0 });
});

// Admin: Management
app.get("/admin/contests", verifyToken, verifyAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const total = await contestsCollection.countDocuments();
    const contests = await contestsCollection.find().skip((page - 1) * limit).limit(limit).toArray();
    res.send({ contests, totalPages: Math.ceil(total / limit), currentPage: page, totalContests: total });
});

app.patch("/admin/contests/:id/status", verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const result = await contestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: status } });
    res.send(result);
});

app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
    const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } });
    res.send(result);
});

app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
    const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});

// Creator: Features
app.get("/contests/creator/:email", verifyToken, verifyCreator, async (req, res) => {
    const result = await contestsCollection.find({ creatorEmail: req.params.email }).toArray();
    res.send(result);
});

app.patch("/contests/:id/winner", verifyToken, verifyCreator, async (req, res) => {
    const id = req.params.id;
    const { winnerEmail, winnerName, winnerPhoto } = req.body;
    await contestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { winnerEmail, winnerName, winnerPhoto, winnerDeclaredAt: new Date() } });
    await participantsCollection.updateOne({ contestId: id, userEmail: winnerEmail }, { $set: { isWinner: true } });
    res.send({ success: true });
});

app.get("/submissions/:contestId", verifyToken, verifyCreator, async (req, res) => {
    const result = await participantsCollection.find({ contestId: req.params.contestId, submittedTask: { $exists: true } }).toArray();
    res.send(result);
});

// User: Features
app.post("/verify-payment", verifyToken, async (req, res) => {
    const { sessionId } = req.body;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === "paid") {
            const { contestId, contestName, userEmail, userName, userPhoto } = session.metadata;
            const existing = await participantsCollection.findOne({ contestId, userEmail });
            if (existing) return res.send({ success: true, message: "Already registered" });

            await participantsCollection.insertOne({ contestId, contestName, userEmail, userName, userPhoto, paymentId: session.id, createdAt: new Date() });
            await contestsCollection.updateOne({ _id: new ObjectId(contestId) }, { $inc: { participantsCount: 1 } });
            res.send({ success: true });
        }
    } catch (error) {
        res.status(500).send({ message: "Verification failed" });
    }
});

// Check if user is registered for a specific contest
app.get("/participants/check", verifyToken, async (req, res) => {
    try {
        const { contestId, email } = req.query;
        const participant = await participantsCollection.findOne({ 
            contestId: contestId, 
            userEmail: email 
        });

        if (participant) {
            res.send({ isRegistered: true, participant });
        } else {
            res.send({ isRegistered: false });
        }
    } catch (error) {
        res.status(500).send({ message: "Error checking status" });
    }
});

app.get("/participants/:email", verifyToken, async (req, res) => {
    const result = await participantsCollection.find({ userEmail: req.params.email }).sort({ createdAt: -1 }).toArray();
    res.send(result);
});

app.patch("/participants/:id/submit", verifyToken, async (req, res) => {
    const result = await participantsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { submittedTask: req.body.submittedTask, submittedAt: new Date() } });
    res.send(result);
});

app.get("/winners/:email", verifyToken, async (req, res) => {
    const winners = await participantsCollection.find({ userEmail: req.params.email, isWinner: true }).toArray();
    const result = await Promise.all(winners.map(async (winner) => {
        const contest = await contestsCollection.findOne({ _id: new ObjectId(winner.contestId) }, { projection: { prizeMoney: 1 } });
        return { ...winner, prizeMoney: contest?.prizeMoney || 0 };
    }));
    res.send(result);
});

app.patch("/users/:email", verifyToken, async (req, res) => {
    const result = await usersCollection.updateOne({ email: req.params.email }, { $set: req.body });
    res.send(result);
});

app.get("/users/:email", verifyToken, async (req, res) => {
    const user = await usersCollection.findOne({ email: req.params.email });
    res.send(user);
});

app.get("/payments/:email", verifyToken, async (req, res) => {
    const result = await paymentsCollection.find({ userEmail: req.params.email }).sort({ paidAt: -1 }).toArray();
    res.send(result);
});



/**
 * SERVER LIFECYCLE
 */
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}

module.exports = app;