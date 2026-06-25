import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs/promises";
import Replicate from "replicate";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Nur Bilddateien sind erlaubt."));
    }
    cb(null, true);
  },
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/* =====================================================
   FESTE EINSTELLUNGEN
   Diese Werte werden NICHT mehr vom Frontend ausgewählt.
===================================================== */

const FIXED_STYLE = "cartoon";
const FIXED_VIEW_TYPE = "fullbody";
const FIXED_PEOPLE_MODE = "allPeople";
const FIXED_LIKENESS = "veryHigh";
const FIXED_ASPECT_RATIO = "4:5";

/* =====================================================
   1. Sichere Verarbeitung der Frontend-Parameter
===================================================== */

function cleanText(value, fallback = "", maxLength = 500) {
  if (value === undefined || value === null) return fallback;

  if (Array.isArray(value)) {
    value = value[0];
  }

  const text = String(value)
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return fallback;

  return text.slice(0, maxLength);
}

function normalizeOption(value, fallback, allowedValues, aliases = {}) {
  let text = cleanText(value, fallback, 100);

  if (aliases[text]) {
    text = aliases[text];
  }

  if (allowedValues.includes(text)) {
    return text;
  }

  return fallback;
}

function normalizeAccessories(input) {
  if (!input) return [];

  let values = [];

  if (Array.isArray(input)) {
    values = input;
  } else if (typeof input === "string") {
    const trimmed = input.trim();

    if (!trimmed) {
      values = [];
    } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        values = Array.isArray(parsed) ? parsed : [];
      } catch {
        values = trimmed.split(",");
      }
    } else {
      values = trimmed.split(",");
    }
  } else {
    values = [input];
  }

  const aliases = {
    glasses: "glasses",
    brille: "glasses",

    crown: "crown",
    krone: "crown",

    flowers: "flowers",
    blumen: "flowers",

    headphones: "headphones",
    kopfhoerer: "headphones",
    kopfhörer: "headphones",
  };

  const allowed = ["glasses", "crown", "flowers", "headphones"];

  return [
    ...new Set(
      values
        .map((item) => cleanText(item, "", 80))
        .map((item) => aliases[item] || item)
        .filter((item) => allowed.includes(item))
    ),
  ];
}

/* =====================================================
   2. Prompt-Teile
===================================================== */

function getBackgroundText(background) {
  const backgrounds = {
    clean:
      "BACKGROUND REQUIREMENT: Use a simple clean light background. The background must not distract from the person or people.",

    studio:
      "BACKGROUND REQUIREMENT: Use a professional studio background with soft lighting. The background must look clean and premium.",

    city:
      "BACKGROUND REQUIREMENT: Use a modern city background, slightly blurred. Keep the person or people as the clear focus.",

    restaurant:
      "BACKGROUND REQUIREMENT: Use a cozy restaurant or café background, warm and slightly blurred. Do not make the background too busy.",

    fantasy:
      "BACKGROUND REQUIREMENT: Use a tasteful fantasy-style background with soft magical lighting. Keep it elegant, not childish.",
  };

  return backgrounds[background] || backgrounds.clean;
}

function getMoodText(mood) {
  const moods = {
    friendly:
      "MOOD REQUIREMENT: The avatar should look friendly, warm, natural, positive, and approachable.",

    professional:
      "MOOD REQUIREMENT: The avatar should look professional, confident, polished, and trustworthy.",

    funny:
      "MOOD REQUIREMENT: The avatar should look cheerful and slightly playful, but not exaggerated, silly, or distorted.",
  };

  return moods[mood] || moods.friendly;
}

function getOutfitText(outfit) {
  const outfits = {
    keep:
      "OUTFIT REQUIREMENT: Keep the original clothing style as much as possible. Do not invent a completely different outfit unless necessary for full-body completion.",

    casual:
      "OUTFIT REQUIREMENT: Use a casual outfit. The outfit should look natural and fit the person.",

    formal:
      "OUTFIT REQUIREMENT: Use a formal elegant outfit. The outfit should look professional and fit the person.",

    sporty:
      "OUTFIT REQUIREMENT: Use a sporty outfit. The outfit should look natural and fit the person.",

    traditional:
      "OUTFIT REQUIREMENT: Use a tasteful traditional outfit. Do not make it costume-like or exaggerated.",

    creative:
      "OUTFIT REQUIREMENT: Use a creative trendy outfit. Keep it stylish but not distracting.",
  };

  return outfits[outfit] || outfits.keep;
}

function getAccessoriesText(accessories) {
  if (!accessories || accessories.length === 0) {
    return "ACCESSORY REQUIREMENT: Do not add unnecessary accessories.";
  }

  const map = {
    glasses: "stylish glasses",
    crown: "a small elegant crown",
    flowers: "subtle decorative flowers",
    headphones: "modern headphones",
  };

  const accessoryNames = accessories.map((item) => map[item] || item);

  return `
ACCESSORY REQUIREMENT:
Add these selected accessories: ${accessoryNames.join(", ")}.
The accessories should be visible but natural.
Do not cover the eyes, eyebrows, nose, mouth, face shape, hairstyle, or important identity features.
If an accessory makes identity less recognizable, reduce it or make it subtle.
`;
}

function getPeopleText() {
  return `
PEOPLE REQUIREMENT - VERY IMPORTANT:
Count the number of clearly visible people in the uploaded image.

The output MUST contain exactly the same number of clearly visible people.
If the uploaded image contains multiple people, every visible person must appear in the final image.

Do not remove any person.
Do not ignore any person.
Do not merge two people into one.
Do not create only one avatar when multiple people are visible.
Do not add extra people.

Preserve:
- left-to-right order
- relative positions
- relative body sizes
- pose direction
- distance between people
- individual facial identity
- individual hairstyle
- individual skin tone
- individual age impression
- individual expression
- individual clothing impression

All people must be transformed into the SAME cartoon style.
Do not make one person realistic and another person cartoon.
Do not use mixed illustration styles.
`;
}

function getIdentityText() {
  return `
IDENTITY REQUIREMENT - VERY HIGH:
This is an image-to-image transformation, not a new character creation.

The result must still look like the uploaded person or uploaded people.

Preserve for every visible person:
- face shape and jawline
- cheeks and forehead
- eye shape, eye spacing, eyelids, and gaze
- eyebrows
- nose shape
- lips and smile
- skin tone
- hairstyle, hairline, and hair color
- beard or mustache
- glasses or unique visible features
- age impression
- facial expression
- head angle and camera perspective

Do not beautify the face.
Do not make the face younger, older, thinner, wider, smoother, more symmetrical, doll-like, celebrity-like, or generic.
Do not change ethnicity, gender expression, skin tone, hairstyle, beard, eyes, nose, lips, or facial proportions.
`;
}

function getStyleText() {
  return `
STYLE REQUIREMENT:
Create a polished modern cartoon avatar illustration.

Use one consistent cartoon style for the entire image.
The result should look friendly, clean, colorful, and suitable for a public diversity wall.

Important:
- cartoon style, not anime
- cartoon style, not sticker-only
- cartoon style, not realistic 3D
- cartoon style, not Disney, Pixar, Bitmoji, Snapchat, or any specific brand style
- keep enough facial detail so every person remains recognizable
`;
}

function getViewText() {
  return `
VIEW REQUIREMENT - FULL BODY:
Show every visible person as a full-body figure from head to toe.

Do not crop:
- head
- face
- hair
- hands
- legs
- feet
- body

If the original photo shows only head, shoulders, or upper body, extend the missing lower body naturally.
The generated full body should match the person's appearance, pose, clothing style, body proportions, and perspective as much as possible.

Keep the face clearly visible and recognizable.
Do not make the face too small.
Leave enough space around all people so nobody is cut off.
`;
}

/* =====================================================
   3. Prompt bauen
===================================================== */

function buildPrompt({
  background,
  mood,
  outfit,
  accessories,
  extraPrompt,
}) {
  const safeExtraPrompt = cleanText(extraPrompt, "", 700);

  const lockedSettings = `
LOCKED SETTINGS:
- style: ${FIXED_STYLE}
- view type: ${FIXED_VIEW_TYPE}
- people mode: ${FIXED_PEOPLE_MODE}
- identity preservation: ${FIXED_LIKENESS}
- background: ${background}
- mood: ${mood}
- outfit: ${outfit}
- accessories: ${accessories.length > 0 ? accessories.join(", ") : "none"}

These settings are mandatory.
If there is a conflict, identity preservation and keeping all people are the highest priorities.
`;

  return `
TASK:
Transform the uploaded photo into a full-body cartoon avatar illustration.

${lockedSettings}

PRIORITY ORDER:
1. Keep every visible person in the output.
2. Preserve identity and facial likeness of every person.
3. Create full-body figures from head to toe.
4. Use one consistent cartoon style for everyone.
5. Apply selected background, mood, outfit, and accessories.
6. Make the final image clean, polished, printable, and high quality.

${getPeopleText()}

${getIdentityText()}

${getStyleText()}

${getViewText()}

${getBackgroundText(background)}

${getMoodText(mood)}

${getOutfitText(outfit)}

${getAccessoriesText(accessories)}

QUALITY RULES:
The final image should be clean, polished, high-quality, colorful, positive, and visually appealing.
It should be suitable for printing and displaying on a public diversity wall.

Avoid:
- text
- logos
- watermarks
- distorted hands
- extra fingers
- missing fingers
- duplicated faces
- missing faces
- cropped faces
- cropped feet
- changed identities
- mixed styles
- extra people
- removed people
- blurry faces
- over-smoothed faces

FINAL CHECKLIST BEFORE OUTPUT:
- Are all visible people from the original image still present?
- Is the number of people correct?
- Is every person full-body from head to toe?
- Is every face recognizable?
- Is everyone in the same cartoon style?
- Is the selected background used?
- Is the selected mood used?
- Is the selected outfit direction used?
- Are selected accessories included naturally?
- Is the final image clean and printable?

${safeExtraPrompt ? `ADDITIONAL USER REQUEST: ${safeExtraPrompt}. Apply this only if it does not conflict with identity, full-body view, or people count.` : ""}
`;
}

/* =====================================================
   4. Bild und Replicate Output
===================================================== */

async function fileToDataURI(filePath, mimeType) {
  const fileBuffer = await fs.readFile(filePath);
  const base64 = fileBuffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

async function normalizeOutput(output) {
  if (!output) return null;

  console.log("Replicate output:", output);

  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output) && output.length > 0) {
    const first = output[0];

    if (typeof first === "string") {
      return first;
    }

    if (first && typeof first.url === "function") {
      const url = first.url();
      return url.toString();
    }

    if (first && typeof first.url === "string") {
      return first.url;
    }

    if (first && typeof first.blob === "function") {
      const blob = await first.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return `data:image/png;base64,${buffer.toString("base64")}`;
    }
  }

  if (typeof output === "object") {
    if (typeof output.url === "function") {
      const url = output.url();
      return url.toString();
    }

    if (typeof output.url === "string") {
      return output.url;
    }

    if (Array.isArray(output.output) && output.output.length > 0) {
      return await normalizeOutput(output.output);
    }
  }

  return null;
}

/* =====================================================
   5. Routes
===================================================== */

app.get("/", (req, res) => {
  res.json({
    message: "Avatar server läuft.",
    fixedSettings: {
      style: FIXED_STYLE,
      viewType: FIXED_VIEW_TYPE,
      peopleMode: FIXED_PEOPLE_MODE,
      likeness: FIXED_LIKENESS,
      aspectRatio: FIXED_ASPECT_RATIO,
    },
  });
});

app.post("/api/avatar", upload.single("image"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!process.env.REPLICATE_API_TOKEN) {
      return res.status(500).json({
        error: "REPLICATE_API_TOKEN fehlt in der .env Datei.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Kein Bild hochgeladen.",
      });
    }

    uploadedFilePath = req.file.path;

    /*
      Diese Werte bleiben vom Frontend steuerbar:
      - background
      - mood
      - outfit
      - accessories
      - extraPrompt

      Diese Werte sind fest:
      - style = cartoon
      - viewType = fullbody
      - peopleMode = allPeople
      - likeness = veryHigh

      Gelöscht:
      - format
      - customOutfit
    */

    const background = normalizeOption(
      req.body.background,
      "clean",
      ["clean", "studio", "city", "restaurant", "fantasy"]
    );

    const mood = normalizeOption(
      req.body.mood,
      "friendly",
      ["friendly", "professional", "funny"]
    );

    const outfit = normalizeOption(
      req.body.outfit,
      "keep",
      ["keep", "casual", "formal", "sporty", "traditional", "creative"]
    );

    const extraPrompt = cleanText(req.body.extraPrompt, "", 700);
    const accessories = normalizeAccessories(req.body.accessories);

    const prompt = buildPrompt({
      background,
      mood,
      outfit,
      accessories,
      extraPrompt,
    });

    const inputImage = await fileToDataURI(req.file.path, req.file.mimetype);

    const model =
      process.env.REPLICATE_MODEL || "black-forest-labs/flux-kontext-dev";

    const output = await replicate.run(model, {
      input: {
        input_image: inputImage,
        prompt,
        aspect_ratio: FIXED_ASPECT_RATIO,
        output_format: "jpg",
      },
    });

    const imageUrl = await normalizeOutput(output);

    if (!imageUrl) {
      return res.status(500).json({
        error: "Es konnte kein Bild aus der Replicate-Antwort gelesen werden.",
        rawOutput: output,
      });
    }

    return res.json({
      success: true,
      imageUrl,
      prompt,
      settings: {
        style: FIXED_STYLE,
        viewType: FIXED_VIEW_TYPE,
        peopleMode: FIXED_PEOPLE_MODE,
        likeness: FIXED_LIKENESS,
        background,
        mood,
        outfit,
        accessories,
        extraPrompt,
        aspectRatio: FIXED_ASPECT_RATIO,
        model,
      },
    });
  } catch (error) {
    console.error("Fehler bei Avatar-Erstellung:", error);

    return res.status(500).json({
      error: "Avatar konnte nicht erstellt werden.",
      details: error.message || "Unbekannter Fehler",
    });
  } finally {
    if (uploadedFilePath) {
      try {
        await fs.unlink(uploadedFilePath);
      } catch (err) {
        console.warn(
          "Temporäre Datei konnte nicht gelöscht werden:",
          err.message
        );
      }
    }
  }
});

/* =====================================================
   6. Allgemeiner Fehlerhandler
===================================================== */

app.use((err, req, res, next) => {
  console.error("Serverfehler:", err);

  return res.status(500).json({
    error: "Serverfehler.",
    details: err.message || "Unbekannter Fehler",
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});