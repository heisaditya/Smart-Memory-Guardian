const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const db = require('./firebaseConfig');
const Tesseract = require('tesseract.js');
const { google } = require('googleapis');
const webpush = require('web-push');
require('dotenv').config();

const app = express();
const port = 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
let groq = null;
if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here') {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log('Groq AI client initialized - extraction feature ready');
} else {
  console.error('❌ GROQ_API_KEY not configured!');
  console.error('The extraction feature will not work without a valid Groq API key.');
  console.error('Get your API key from: https://console.groq.com/keys');
  console.error('Then update the GROQ_API_KEY in your .env file');
  process.exit(1);
}

let webpushConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:your-email@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  webpushConfigured = true;
} else {
  console.log('Web Push notifications not configured - VAPID keys missing');
}

let calendar = null;
let oauth2Client = null;
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/auth/google/callback'
  );
  calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  console.log('Google Calendar integration configured');
} else {
  console.log('Google Calendar integration not configured - missing credentials');
}

app.get('/tasks', async (req, res) => {
  try {
    const tasksRef = db.collection('tasks');
    const snapshot = await tasksRef.get();
    const tasks = [];
    snapshot.forEach(doc => {
      tasks.push({ id: doc.id, ...doc.data() });
    });

    // Sort tasks by priority (High -> Medium -> Low) and then by createdAt
    const priorityOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
    tasks.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({
      "message": "success",
      "data": tasks
    });
  } catch (error) {
    console.error("Error fetching tasks from Firestore: ", error);
    res.status(500).json({ "error": error.message });
  }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.collection('tasks').doc(id).update({ status: 'completed' });
    res.json({ "message": "Task marked as completed", id: id });
  } catch (error) {
    console.error("Error marking task as completed in Firestore: ", error);
    res.status(500).json({ "error": error.message });
  }
});

app.get('/tasks/categories', async (req, res) => {
  try {
    const tasksRef = db.collection('tasks');
    const snapshot = await tasksRef.get();
    const categories = new Set();

    snapshot.forEach(doc => {
      const taskData = doc.data();
      if (taskData.category) {
        categories.add(taskData.category);
      }
    });

    res.json({
      "message": "success",
      "data": Array.from(categories).sort()
    });
  } catch (error) {
    console.error("Error fetching categories from Firestore: ", error);
    res.status(500).json({ "error": error.message });
  }
});

app.get('/tasks/category/:category', async (req, res) => {
  try {
    const category = req.params.category;
    const tasksRef = db.collection('tasks');
    const snapshot = await tasksRef.where('category', '==', category).get();
    const tasks = [];

    snapshot.forEach(doc => {
      tasks.push({ id: doc.id, ...doc.data() });
    });

    const priorityOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
    tasks.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({
      "message": "success",
      "data": tasks
    });
  } catch (error) {
    console.error("Error fetching tasks by category from Firestore: ", error);
    res.status(500).json({ "error": error.message });
  }
});





app.post('/groq', async (req, res) => {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: req.body.messages,
      model: req.body.model || "llama-3.3-70b-versatile",
      temperature: req.body.temperature || 0,
    });
    const aiResponseContent = chatCompletion.choices[0].message.content.trim();

    let cleanContent = aiResponseContent;
    const jsonMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      cleanContent = jsonMatch[1].trim();
    }

    const parsedContent = JSON.parse(cleanContent);
    await db.collection('tasks').add({
      summary: parsedContent.summary,
      deadline: parsedContent.deadline,
      fine: parsedContent.fine,
      priority: parsedContent.priority,
      category: parsedContent.category || 'General',
      createdAt: new Date().toISOString(),
      status: 'pending'
    });
    res.json(chatCompletion);
  } catch (error) {
    console.error("Error communicating with Groq API:", error);
    res.status(500).json({ error: "Failed to communicate with Groq API" });
  }
});

app.post('/process-screenshot', async (req, res) => {
  try {
    const { imageData } = req.body;
    if (!imageData) {
      return res.status(400).json({ error: "No image data provided." });
    }

    let imageBuffer;
    if (imageData.startsWith('data:image/png;base64,')) {
      const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    } else {
      imageBuffer = Buffer.from(imageData, 'base64');
    }

    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
    if (!text || text.trim() === '') {
      return res.status(400).json({ error: "No text found in screenshot." });
    }

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: `Extract only important reminder details.\n\nReturn STRICT JSON ONLY:\n{\n"summary":"short summary",\n"deadline":"date if exists else Not Found",\n"fine":"fine if exists else None",\n"priority":"High | Medium | Low",\n"category":"Work | Personal | Health | Finance | Education | Other"\n}\n\nText:\n${text}`}],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
    });

    const aiResponseContent = chatCompletion.choices[0].message.content.trim();

    let cleanContent = aiResponseContent;
    const jsonMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      cleanContent = jsonMatch[1].trim();
    }

    const parsedContent = JSON.parse(cleanContent);
    await db.collection('tasks').add({
      summary: parsedContent.summary,
      deadline: parsedContent.deadline,
      fine: parsedContent.fine,
      priority: parsedContent.priority,
      category: parsedContent.category || 'General',
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    res.json({ message: "success", data: parsedContent });

  } catch (error) {
    console.error("Error processing screenshot:", error);
    res.status(500).json({ error: "Failed to process screenshot: " + error.message });
  }
});

app.get('/notifications/check', async (req, res) => {
  try {
    const tasksRef = db.collection('tasks');
    const snapshot = await tasksRef.where('status', '==', 'pending').get();
    const notifications = [];
    const now = new Date();

    snapshot.forEach(doc => {
      const task = { id: doc.id, ...doc.data() };

      if (task.deadline && task.deadline !== 'Not Found') {
        try {
          const deadline = new Date(task.deadline);
          const timeDiff = deadline.getTime() - now.getTime();
          const hoursDiff = timeDiff / (1000 * 60 * 60);

          if (hoursDiff > 0 && hoursDiff <= 24) {
            notifications.push({
              id: task.id,
              summary: task.summary,
              deadline: task.deadline,
              priority: task.priority,
              hoursRemaining: Math.round(hoursDiff),
              urgency: hoursDiff <= 2 ? 'urgent' : hoursDiff <= 6 ? 'warning' : 'normal'
            });
          }
        } catch (error) {
          console.error(`Error parsing deadline for task ${task.id}:`, error);
        }
      }
    });

    const urgencyOrder = { 'urgent': 1, 'warning': 2, 'normal': 3 };
    notifications.sort((a, b) => {
      const urgencyDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      if (urgencyDiff !== 0) return urgencyDiff;
      return a.hoursRemaining - b.hoursRemaining;
    });

    res.json({
      "message": "success",
      "data": notifications
    });
  } catch (error) {
    console.error("Error checking notifications:", error);
    res.status(500).json({ "error": error.message });
  }
});

app.get('/suggestions', async (req, res) => {
  try {
    const tasksRef = db.collection('tasks');
    const snapshot = await tasksRef.where('status', '==', 'pending').get();
    const tasks = [];

    snapshot.forEach(doc => {
      tasks.push({ id: doc.id, ...doc.data() });
    });

    if (tasks.length === 0) {
      return res.json({
        "message": "success",
        "data": ["No pending tasks to analyze. Great job staying on top of things!"]
      });
    }

    const taskSummary = tasks.map(task =>
      `- ${task.priority} priority: ${task.summary} (Deadline: ${task.deadline}, Category: ${task.category})`
    ).join('\n');

    const chatCompletion = await groq.chat.completions.create({
      messages: [{
        role: "user",
        content: `Analyze these tasks and provide 3-5 specific, actionable suggestions to optimize productivity and meet deadlines. Consider priorities, deadlines, categories, and potential conflicts. Be concise but helpful.

Tasks:
${taskSummary}

Return suggestions as a JSON array of strings.`
      }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
    });

    const aiResponseContent = chatCompletion.choices[0].message.content.trim();

    let suggestions = [];
    try {
      const jsonMatch = aiResponseContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      } else {
        suggestions = [aiResponseContent];
      }
    } catch (error) {
      suggestions = ["Unable to parse AI suggestions. Please try again."];
    }

    res.json({
      "message": "success",
      "data": suggestions
    });
  } catch (error) {
    console.error("Error getting suggestions:", error);
    res.status(500).json({ "error": error.message });
  }
});



app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

