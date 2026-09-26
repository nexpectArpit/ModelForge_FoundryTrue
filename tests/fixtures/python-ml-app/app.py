import os
from openai import OpenAI

MODEL_NAME = os.environ.get("MODEL_NAME", "gpt-4o")
API_KEY = os.environ.get("OPENAI_API_KEY")

client = OpenAI(api_key=API_KEY)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": "Search internal documentation for relevant articles",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query text"},
                    "max_results": {"type": "integer", "description": "Maximum results to return"},
                    "category": {"type": "string", "enum": ["engineering", "product", "hr", "legal"]}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_summary",
            "description": "Create a summary of provided documents",
            "parameters": {
                "type": "object",
                "properties": {
                    "document_ids": {"type": "array", "items": {"type": "string"}},
                    "format": {"type": "string", "enum": ["brief", "detailed", "executive"]}
                },
                "required": ["document_ids", "format"]
            }
        }
    }
]

SYSTEM_PROMPT = """You are a document analysis assistant.
You help users find, summarize, and analyze internal documents.
Use the provided tools when a search or summary is requested."""


def chat(user_message: str) -> dict:
    response = client.chat.completions.create(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message}
        ],
        tools=TOOLS,
        temperature=0.3
    )
    return {
        "response": response.choices[0].message.content,
        "tool_calls": [
            {"name": tc.function.name, "arguments": tc.function.arguments}
            for tc in (response.choices[0].message.tool_calls or [])
        ]
    }
