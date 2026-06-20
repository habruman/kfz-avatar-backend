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
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Nur Bilddateien sind erlaubt."));
    }
    cb(null, true);
  }
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

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
    kopfhörer: "headphones"
  };

  const allowed = ["glasses", "crown", "flowers", "headphones"];

  return [
    ...new Set(
      values
        .map(item => cleanText(item, "", 80))
        .map(item => aliases[item] || item)
        .filter(item => allowed.includes(item))
    )
  ];
}

/* =====================================================
   2. Texte für Prompt-Teile
===================================================== */

function getAspectRatio(format, viewType, peopleMode) {
  // Bei mehreren Personen besser 4:5, damit niemand abgeschnitten wird.
  if (peopleMode === "allPeople") return "4:5";

  if (format === "instagram") return "4:5";
  if (viewType === "fullbody") return "4:5";
  if (format === "sticker") return "1:1";

  return "1:1";
}

function getStyleText(style) {
  const styles = {
    avatar:
      "STYLE REQUIREMENT: Create a polished modern semi-realistic 3D avatar. Keep the real facial identity visible. Do not make the face generic or doll-like.",

    cartoon:
      "STYLE REQUIREMENT: Create a polished cartoon avatar. Keep the real facial structure and identity visible. Do not simplify the face too much.",

    anime:
      "STYLE REQUIREMENT: Create an anime-inspired avatar, but preserve the real face. Avoid generic anime eyes, generic anime nose, or a completely new anime character.",

    sticker:
      "STYLE REQUIREMENT: Create a clean sticker-style avatar with clear outlines. Keep the real face recognizable and do not hide facial details."
  };

  return styles[style] || styles.avatar;
}

function getViewText(viewType, peopleMode) {
  if (viewType === "fullbody") {
    if (peopleMode === "allPeople") {
      return "VIEW REQUIREMENT: Show all visible people as full-body figures from head to toe. Do not crop heads, faces, feet, or bodies.";
    }

    return "VIEW REQUIREMENT: Show the main person as a full-body figure from head to toe. Do not crop the head, face, feet, or body.";
  }

  if (peopleMode === "allPeople") {
    return "VIEW REQUIREMENT: Create a clear group portrait. Show all visible faces clearly as head-and-shoulders or upper-body portrait.";
  }

  return "VIEW REQUIREMENT: Create a clear head-and-shoulders portrait of the main person. Keep the face large, centered, and readable.";
}

function getBackgroundText(background) {
  const backgrounds = {
    clean:
      "BACKGROUND REQUIREMENT: Use a simple clean light background. The background must not distract from the person.",

    studio:
      "BACKGROUND REQUIREMENT: Use a professional studio background with soft lighting. The background must look clean and premium.",

    city:
      "BACKGROUND REQUIREMENT: Use a modern city background, slightly blurred. Keep the person as the clear focus.",

    restaurant:
      "BACKGROUND REQUIREMENT: Use a cozy restaurant or café background, warm and slightly blurred. Do not make the background too busy.",

    fantasy:
      "BACKGROUND REQUIREMENT: Use a tasteful fantasy-style background with soft magical lighting. Keep it elegant, not childish."
  };

  return backgrounds[background] || backgrounds.clean;
}

function getMoodText(mood) {
  const moods = {
    friendly:
      "MOOD REQUIREMENT: The avatar should look friendly, warm, natural, and approachable.",

    professional:
      "MOOD REQUIREMENT: The avatar should look professional, confident, polished, and trustworthy.",

    funny:
      "MOOD REQUIREMENT: The avatar should look cheerful and slightly playful, but not exaggerated or silly."
  };

  return moods[mood] || moods.friendly;
}

function getFormatText(format, peopleMode) {
  if (format === "instagram") {
    return "FORMAT REQUIREMENT: Compose the image like a high-quality Instagram post. Leave enough space around the person or people. Do not crop important parts.";
  }

  if (format === "sticker") {
    if (peopleMode === "allPeople") {
      return "FORMAT REQUIREMENT: Compose the image like a clean group sticker. All people must remain visible inside the sticker composition.";
    }

    return "FORMAT REQUIREMENT: Compose the image like a clean sticker. The person must remain fully visible inside the sticker composition.";
  }

  if (peopleMode === "allPeople") {
    return "FORMAT REQUIREMENT: Compose the image like a clean profile/group picture. All visible faces should remain visible and recognizable.";
  }

  return "FORMAT REQUIREMENT: Compose the image like a clean profile picture. The face should be clear, centered, and recognizable.";
}

function getOutfitText(outfit, customOutfit) {
  const custom = cleanText(customOutfit, "", 300);

  if (custom) {
    return `OUTFIT REQUIREMENT: Change or adapt the outfit to: "${custom}". This outfit instruction is important, but it must not change the face, age, skin tone, body identity, or facial likeness.`;
  }

  const outfits = {
    keep:
      "OUTFIT REQUIREMENT: Keep the original clothing style as much as possible.",

    casual:
      "OUTFIT REQUIREMENT: Use a casual outfit. The outfit should look natural and fit the person.",

    formal:
      "OUTFIT REQUIREMENT: Use a formal elegant outfit. The outfit should look professional and fit the person.",

    sporty:
      "OUTFIT REQUIREMENT: Use a sporty outfit. The outfit should look natural and fit the person.",

    traditional:
      "OUTFIT REQUIREMENT: Use a tasteful traditional outfit. Do not make it costume-like or exaggerated.",

    creative:
      "OUTFIT REQUIREMENT: Use a creative trendy outfit. Keep it stylish but not distracting."
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
    headphones: "modern headphones"
  };

  const accessoryNames = accessories.map(item => map[item] || item);

  return `
ACCESSORY REQUIREMENT:
Add these selected accessories: ${accessoryNames.join(", ")}.
The accessories should be visible but natural.
Do not cover the eyes, eyebrows, nose, mouth, face shape, hairstyle, or important identity features.
`;
}

function getPeopleText(peopleMode) {
  if (peopleMode === "mainPerson") {
    return `
PEOPLE REQUIREMENT:
Transform only the main person in the image.
The main person is the largest, most central, or clearest face.
Ignore background people.
Do not create extra people.
`;
  }

  return `
PEOPLE REQUIREMENT:
If the uploaded image contains multiple clearly visible people, transform ALL clearly visible people.
Keep the same number of clearly visible people as in the uploaded image.
Do not remove a person.
Do not ignore a person.
Do not merge people.
Do not create only one avatar when multiple people are visible.
Preserve left-to-right order, relative positions, poses, and body sizes.
Each person must keep their own facial identity, hairstyle, skin tone, age impression, expression, and clothing impression.
`;
}

function getLikenessText(likeness) {
  if (likeness === "medium") {
    return `
IDENTITY REQUIREMENT:
Keep the person generally recognizable, but allow stronger stylization.
Do not create a completely different face.
Do not replace the person with a generic avatar.
`;
  }

  if (likeness === "high") {
    return `
IDENTITY REQUIREMENT:
Keep the person clearly recognizable.
Preserve face shape, eyes, eyebrows, nose, mouth, skin tone, hairstyle, facial hair, age impression, and expression.
Stylize the image, but do not change the main facial features.
`;
  }

  return `
IDENTITY REQUIREMENT - VERY HIGH:
This is an image-to-image transformation, not a new character creation.

The result must still look like the uploaded person or uploaded people.

Preserve:
- face shape and jawline
- cheeks and forehead
- eye shape, eye spacing, eyelids, and gaze
- eyebrows
- nose shape
- lips and smile
- skin tone
- hairstyle, hairline, hair color
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

/* =====================================================
   3. Prompt bauen
===================================================== */

function buildPrompt({
  style,
  viewType,
  background,
  mood,
  format,
  outfit,
  customOutfit,
  accessories,
  likeness,
  peopleMode,
  extraPrompt
}) {
  const safeExtraPrompt = cleanText(extraPrompt, "", 600);

  const lockedSettings = `
LOCKED USER SETTINGS:
- style: ${style}
- view type: ${viewType}
- background: ${background}
- mood: ${mood}
- format: ${format}
- outfit: ${customOutfit ? customOutfit : outfit}
- accessories: ${accessories.length > 0 ? accessories.join(", ") : "none"}
- identity preservation: ${likeness}
- people mode: ${peopleMode}

These locked settings are mandatory.
Do not ignore the selected style, background, outfit, mood, format, accessories, or people mode.
If there is a conflict, identity preservation is the highest priority.
`;

  return `
TASK:
Transform the uploaded photo into an avatar illustration.

${lockedSettings}

PRIORITY ORDER:
1. Preserve identity and facial likeness.
2. Follow the people requirement.
3. Follow the selected user settings.
4. Apply the requested avatar style.
5. Make the final image clean and high quality.

${getPeopleText(peopleMode)}

${getLikenessText(likeness)}

${getStyleText(style)}

${getViewText(viewType, peopleMode)}

${getFormatText(format, peopleMode)}

${getBackgroundText(background)}

${getMoodText(mood)}

${getOutfitText(outfit, customOutfit)}

${getAccessoriesText(accessories)}

QUALITY RULES:
The final result should be clean, polished, high-quality, and visually appealing.
Avoid text, logos, watermarks, distorted hands, extra fingers, duplicated faces, missing faces, cropped faces, and changed identities.
Do not copy Snapchat, Bitmoji, Disney, Pixar, or any specific brand style.

FINAL CHECKLIST BEFORE OUTPUT:
- Is the person still recognizable?
- Are all selected settings applied?
- Is the correct number of people shown?
- Is the selected background used?
- Is the selected outfit used?
- Are selected accessories included naturally?
- Is the image in the selected style?

${safeExtraPrompt ? `ADDITIONAL USER REQUEST: ${safeExtraPrompt}. Apply this only if it does not conflict with identity or people count.` : ""}
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
    message: "Avatar server läuft."
  });
});

app.post("/api/avatar", upload.single("image"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!process.env.REPLICATE_API_TOKEN) {
      return res.status(500).json({
        error: "REPLICATE_API_TOKEN fehlt in der .env Datei."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Kein Bild hochgeladen."
      });
    }

    uploadedFilePath = req.file.path;

    const style = normalizeOption(
      req.body.style,
      "avatar",
      ["avatar", "cartoon", "anime", "sticker"],
      {
        "3d": "avatar",
        "modern3d": "avatar",
        "modern-3d": "avatar"
      }
    );

    const viewType = normalizeOption(
      req.body.viewType,
      "portrait",
      ["portrait", "fullbody"],
      {
        "full-body": "fullbody",
        "full_body": "fullbody"
      }
    );

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

    const format = normalizeOption(
      req.body.format,
      "profile",
      ["profile", "instagram", "sticker"],
      {
        "profile-picture": "profile",
        "profile_picture": "profile"
      }
    );

    const outfit = normalizeOption(
      req.body.outfit,
      "keep",
      ["keep", "casual", "formal", "sporty", "traditional", "creative"]
    );

    const likeness = normalizeOption(
      req.body.likeness,
      "veryHigh",
      ["medium", "high", "veryHigh"],
      {
        "very-high": "veryHigh",
        "very_high": "veryHigh",
        "veryhigh": "veryHigh"
      }
    );

    const peopleMode = normalizeOption(
      req.body.peopleMode,
      "allPeople",
      ["allPeople", "mainPerson"],
      {
        "all": "allPeople",
        "all_people": "allPeople",
        "all-people": "allPeople",
        "group": "allPeople",
        "main": "mainPerson",
        "single": "mainPerson",
        "main_person": "mainPerson",
        "main-person": "mainPerson"
      }
    );

    const customOutfit = cleanText(req.body.customOutfit, "", 300);
    const extraPrompt = cleanText(req.body.extraPrompt, "", 600);
    const accessories = normalizeAccessories(req.body.accessories);

    const aspectRatio = getAspectRatio(format, viewType, peopleMode);

    const prompt = buildPrompt({
      style,
      viewType,
      background,
      mood,
      format,
      outfit,
      customOutfit,
      accessories,
      likeness,
      peopleMode,
      extraPrompt
    });

    const inputImage = await fileToDataURI(req.file.path, req.file.mimetype);

    const output = await replicate.run(
      process.env.REPLICATE_MODEL || "black-forest-labs/flux-kontext-dev",
      {
        input: {
          input_image: inputImage,
          prompt,
          aspect_ratio: aspectRatio,
          output_format: "jpg"
        }
      }
    );

    const imageUrl = await normalizeOutput(output);

    if (!imageUrl) {
      return res.status(500).json({
        error: "Es konnte kein Bild aus der Replicate-Antwort gelesen werden.",
        rawOutput: output
      });
    }

    return res.json({
      success: true,
      imageUrl,
      prompt,
      settings: {
        style,
        viewType,
        background,
        mood,
        format,
        outfit,
        customOutfit,
        accessories,
        likeness,
        peopleMode,
        extraPrompt,
        aspectRatio
      }
    });

  } catch (error) {
    console.error("Fehler bei Avatar-Erstellung:", error);

    return res.status(500).json({
      error: "Avatar konnte nicht erstellt werden.",
      details: error.message || "Unbekannter Fehler"
    });

  } finally {
    if (uploadedFilePath) {
      try {
        await fs.unlink(uploadedFilePath);
      } catch (err) {
        console.warn("Temporäre Datei konnte nicht gelöscht werden:", err.message);
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
    details: err.message || "Unbekannter Fehler"
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});