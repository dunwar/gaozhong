"""
TextIn OCR Integration Module
=============================
Provides TextIn API client and question parsing for gaozhong.

Usage:
    from src.textin import TextInClient, parse_xparse_result

    client = TextInClient(app_id, secret_code)
    result = client.parse_document("exam_page.jpg")
    questions = parse_xparse_result(result.raw_json.get('detail', []))
"""

from .client import TextInClient, create_client_from_config
from .parser import TextInQuestionParser, parse_xparse_result

__all__ = [
    'TextInClient',
    'create_client_from_config',
    'TextInQuestionParser',
    'parse_xparse_result',
]
