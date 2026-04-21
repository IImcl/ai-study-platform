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
Educational value rules:
- Every question MUST be genuinely useful for studying the source.
- Prefer questions about the main idea, objective, goal, workflow, methodology, architecture, logic, features, purpose, benefits, limitations, comparisons, inputs/outputs, or reasoning in the source.
- Ask about meaning and understanding, not just surface recall.
- Avoid low-value metadata questions about publisher, publication year, edition, press, copyright, ISBN, author/publisher metadata, title-page facts, or front-page trivia unless publication metadata is itself the topic of the source.
- Avoid isolated proper nouns or tiny surface details when they have little learning value.
- Good question example: "What is the main goal of the platform described in the source?"
- Good question example: "How does the workflow move from uploaded source material to study output?"
- Bad question example: "Which press published the document?"
- Bad question example: "In what year was the document printed?"
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
Educational value rules:
- Every tricky item MUST test meaningful understanding of the source, not cover-page trivia.
- Prefer confusions about purpose, workflow steps, methodology, architecture, feature roles, similarities/differences, limitations, cause/effect, or why one concept is correct over another.
- Avoid low-value metadata questions about publisher, publication year, edition, press, copyright, ISBN, author/publisher metadata, or title-page facts unless publication data is central to the source topic.
- Distractors should reflect realistic conceptual misunderstandings from the source, not random trivia.
- Good tricky example: "Which option best explains why the platform needs source grounding before generation?"
- Good tricky example: "Which workflow step must happen before reliable study output can be produced?"
- Bad tricky example: "Which publisher appears on the cover page?"
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

You previously produced JSON that FAILED validation or quality review.

Allowed citations are ONLY: {allowed}

Quality issues to fix:
{quality_notes}

Rules to fix:
- Every item MUST either:
  (A) include citations that are all in the Allowed list, OR
  (B) if not supported by sources: set answer to "NOT_IN_SOURCES" and set citations to [].
- Replace any weak or low-value metadata-focused question with a more educationally useful question grounded in the source.
- Prefer meaning, concepts, workflow, methodology, architecture, features, purpose, benefits, limitations, comparisons, or reasoning.
- Avoid publisher, publication year, edition, press, copyright, ISBN, author/publisher metadata, title-page trivia, or isolated proper nouns unless those are central to the source topic.
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
