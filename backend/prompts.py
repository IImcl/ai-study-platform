# backend/prompts.py

PRESETS = {
    "quiz_json": """You MUST output valid JSON only (no markdown, no extra text).
Return this exact schema:
{{
  "items": [
    {{
      "type": "mcq",
      "question": "...",
      "choices": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "answer": "C",
      "explanation": "...",
      "citations": ["S1:p1"]
    }},
    {{
      "type": "short",
      "question": "...",
      "answer": "...",
      "explanation": "...",
      "citations": ["S1:p1"]
    }}
  ]
}}

Rules:
- Generate exactly {n} items.
- Use ONLY the SOURCES below. Do NOT use outside knowledge.
- Every claim MUST have citations like "S1:p3".
- If missing in sources: put "NOT_IN_SOURCES" and citations [].
- Write all questions/answers/explanations in language: {language}.
- Difficulty level: {difficulty}. (easy=direct, medium=conceptual, hard=trickier/confusions)
- MODE can be: "mixed", "mcq_only", "short_only". Default "mixed".
- If MODE="mcq_only": all items MUST be mcq.
- If MODE="short_only": all items MUST be short.
- SHUFFLE_CHOICES: if true, shuffle MCQ choices but keep correct "answer" consistent.
- For MCQ items, "answer" MUST be the actual correct letter among A, B, C, or D.
- Do NOT default to "A".
- Distribute correct answer positions naturally across A, B, C, and D when possible.
Style constraints:
- For short-answer items, the answer must be very short: maximum 3 words.
- Accept concise exact answers such as a single number, term, or name when supported by sources.
- Explanation must be concise (max 2 sentences, ideally <= 20 words).
- Do not restate the question.
- Keep wording simple and non-identical to the source phrasing.

SOURCES:
{sources}
""",

    "flashcards_json": """You MUST output valid JSON only (no markdown, no extra text).
Return this exact schema:
{{
  "cards": [
    {{
      "term": "...",
      "definition": "...",
      "example": "...",
      "citations": ["S1:p1"]
    }}
  ]
}}

Rules:
- Create exactly {n} cards.
- Use ONLY the SOURCES below.
- If missing: "NOT_IN_SOURCES" and citations [].
- Write all questions/answers/explanations in language: {language}.
- Difficulty level: {difficulty}. (easy=direct, medium=conceptual, hard=trickier/confusions)
- SHUFFLE_CARDS: if true, shuffle cards order.

SOURCES:
{sources}
""",

    "tricky_json": """You MUST output valid JSON only (no markdown, no extra text).
Return this exact schema:
{{
  "items": [
    {{
      "type": "mcq",
      "question": "...",
      "choices": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "answer": "B",
      "explanation": "Explain why it is tricky and why the correct answer is correct.",
      "citations": ["S1:p1"]
    }}
  ]
}}

Rules:
- Generate exactly {n} tricky items (focus on common confusions).
- Use ONLY the SOURCES below.
- If missing: "NOT_IN_SOURCES" and citations [].
- Write all questions/answers/explanations in language: {language}.
- Difficulty level: {difficulty}. (easy=direct, medium=conceptual, hard=trickier/confusions)
- SHUFFLE_CHOICES: if true, shuffle MCQ choices but keep correct "answer" consistent.
- For MCQ items, "answer" MUST be the actual correct letter among A, B, C, or D.
- Do NOT default to "A".
- Distribute correct answer positions naturally across A, B, C, and D when possible.
Style constraints:
- For short-answer items, the answer must be very short: maximum 3 words.
- Accept concise exact answers such as a single number, term, or name when supported by sources.
- Explanation must be concise (max 2 sentences, ideally <= 20 words).
- Do not restate the question.
- Keep wording simple and non-identical to the source phrasing.

SOURCES:
{sources}
""",

    "repair_json": """You MUST output valid JSON only.

You previously produced JSON that FAILED citation validation.

Allowed citations are ONLY: {allowed}

Rules to fix:
- Every item MUST either:
  (A) include citations that are all in the Allowed list, OR
  (B) if not supported by sources: set answer to "NOT_IN_SOURCES" and set citations to [].
- Keep the SAME schema and SAME number of items as the original output.
- Do NOT add extra keys.

ORIGINAL OUTPUT (invalid):
{bad_output}

SOURCES:
{sources}
"""
}

SCHEMAS = {
    "quiz_json": {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "oneOf": [
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "type",
                                "question",
                                "choices",
                                "answer",
                                "explanation",
                                "citations",
                            ],
                            "properties": {
                                "type": {"type": "string", "enum": ["mcq"]},
                                "question": {"type": "string"},
                                "choices": {"type": "array", "items": {"type": "string"}},
                                "answer": {"type": "string"},
                                "explanation": {"type": "string"},
                                "citations": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                        {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "type",
                                "question",
                                "answer",
                                "explanation",
                                "citations",
                            ],
                            "properties": {
                                "type": {"type": "string", "enum": ["short"]},
                                "question": {"type": "string"},
                                "answer": {"type": "string"},
                                "explanation": {"type": "string"},
                                "citations": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    ]
                },
            }
        },
    },
    "flashcards_json": {
        "type": "object",
        "additionalProperties": False,
        "required": ["cards"],
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["term", "definition", "example", "citations"],
                    "properties": {
                        "term": {"type": "string"},
                        "definition": {"type": "string"},
                        "example": {"type": "string"},
                        "citations": {"type": "array", "items": {"type": "string"}},
                    },
                },
            }
        },
    },
    "tricky_json": {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "type",
                        "question",
                        "choices",
                        "answer",
                        "explanation",
                        "citations",
                    ],
                    "properties": {
                        "type": {"type": "string", "enum": ["mcq"]},
                        "question": {"type": "string"},
                        "choices": {"type": "array", "items": {"type": "string"}},
                        "answer": {"type": "string"},
                        "explanation": {"type": "string"},
                        "citations": {"type": "array", "items": {"type": "string"}},
                    },
                },
            }
        },
    },
}
