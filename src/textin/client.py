"""
TextIn API Client
=================
Low-level client for TextIn REST API.
Handles authentication, request building, and response parsing.

API Endpoints:
    - POST /ai/service/v1/handwritten_erase  - Remove handwriting
    - POST /ai/service/v2/recognize          - OCR text recognition
    - POST /ai/service/v1/xparse             - Document parsing with layout analysis
"""

import requests
import base64
import json
import time
from typing import Dict, List, Optional, Tuple, Union
from pathlib import Path
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)


# API Configuration
TEXTIN_BASE_URL = "https://api.textin.com"

# Endpoint paths
ENDPOINT_ERASE = "/ai/service/v1/handwritten_erase"
ENDPOINT_OCR = "/ai/service/v2/recognize"
ENDPOINT_XPARSE = "/ai/service/v1/xparse"


@dataclass
class EraseResult:
    """Result of handwriting erase operation."""
    success: bool
    image_data: Optional[bytes] = None  # Clean image bytes
    width: int = 0
    height: int = 0
    message: str = ""


@dataclass
class OCRWord:
    """A single word from OCR."""
    text: str
    confidence: float
    bbox: Tuple[int, int, int, int]  # x, y, w, h
    poly: Optional[List[Tuple[int, int]]] = None  # Polygon points


@dataclass
class OCRLine:
    """A line of text from OCR."""
    text: str
    confidence: float
    bbox: Tuple[int, int, int, int]
    words: List[OCRWord] = field(default_factory=list)
    angle: float = 0.0


@dataclass
class OCRResult:
    """Complete OCR result."""
    success: bool
    lines: List[OCRLine] = field(default_factory=list)
    angle: float = 0.0
    width: int = 0
    height: int = 0
    message: str = ""


@dataclass
class ParsedElement:
    """A parsed element from xParse."""
    text: str
    element_type: str  # 'question_number', 'question_text', 'option', 'red_mark', etc.
    bbox: Tuple[int, int, int, int]
    confidence: float = 0.0
    attributes: Dict = field(default_factory=dict)


@dataclass
class ParseResult:
    """Complete document parse result."""
    success: bool
    elements: List[ParsedElement] = field(default_factory=list)
    markdown: str = ""
    raw_json: Dict = field(default_factory=dict)
    message: str = ""


class TextInClient:
    """
    TextIn API client for exam paper processing.
    
    Usage:
        client = TextInClient(app_id="your-id", secret_code="your-code")
        
        # Erase handwriting
        result = client.erase_handwriting("exam.jpg")
        
        # OCR recognition
        ocr = client.recognize_text("clean.jpg")
        
        # Full document parsing
        parsed = client.parse_document("exam.jpg")
    """
    
    def __init__(self, app_id: str, secret_code: str, timeout: int = 60):
        """
        Initialize TextIn client.
        
        Args:
            app_id: Your x-ti-app-id from TextIn console
            secret_code: Your x-ti-secret-code from TextIn console
            timeout: Request timeout in seconds
        """
        self.app_id = app_id
        self.secret_code = secret_code
        self.timeout = timeout
        self.base_url = TEXTIN_BASE_URL
        
        # Prepare common headers
        self.headers = {
            'x-ti-app-id': app_id,
            'x-ti-secret-code': secret_code,
        }
        
        logger.info(f"TextInClient initialized (app_id: {app_id[:8]}...)")
    
    def _read_image(self, image_path: Union[str, Path]) -> bytes:
        """Read image file as bytes."""
        with open(str(image_path), 'rb') as f:
            return f.read()
    
    def _decode_response_image(self, image_base64: str) -> bytes:
        """Decode base64 image from API response."""
        return base64.b64decode(image_base64)
    
    def _make_request(self, endpoint: str, image_data: bytes, 
                      params: Optional[Dict] = None) -> Dict:
        """
        Make POST request to TextIn API.
        
        Args:
            endpoint: API endpoint path
            image_data: Raw image bytes
            params: Optional query parameters
        
        Returns:
            Parsed JSON response
        
        Raises:
            requests.RequestException: On network error
            ValueError: On API error response
        """
        url = f"{self.base_url}{endpoint}"
        
        try:
            response = requests.post(
                url,
                headers=self.headers,
                params=params or {},
                data=image_data,
                timeout=self.timeout
            )
            
            response.raise_for_status()
            result = response.json()
            
            # Check API-level error
            if result.get('code') != 200:
                raise ValueError(
                    f"API error (code={result.get('code')}): "
                    f"{result.get('message', 'Unknown error')}"
                )
            
            return result
            
        except requests.RequestException as e:
            logger.error(f"Request failed: {e}")
            raise
    
    def erase_handwriting(self, image_path: Union[str, Path],
                          crop: int = 0,
                          doc_direction: int = 4,
                          dewarp: int = 1,
                          binarization: int = 1,
                          mask_position: Optional[str] = None) -> EraseResult:
        """
        Remove handwriting from exam paper image.
        
        Uses TextIn's deep learning model to:
        1. Segment image into printed/handwriting/background layers
        2. Remove handwriting layer
        3. GAN-inpaint removed regions with surrounding content
        
        Args:
            image_path: Path to exam paper image
            crop: 0=no crop(default), 1=auto crop
            doc_direction: 0=no rotation, 1=90°CW, 2=180°, 3=270°CW, 4=auto
            dewarp: 0=no dewarp, 1=curve correction(default)
            binarization: 0=no filter, 1=black-white sharpening(default)
            mask_position: Optional manual mask coordinates x1,y1,x2,y2,x3,y3,x4,y4
        
        Returns:
            EraseResult with clean image data
        """
        logger.info(f"Erasing handwriting from: {image_path}")
        
        # Build parameters
        params = {
            'crop': crop,
            'doc_direction': doc_direction,
            'dewarp': dewarp,
            'binarization': binarization,
        }
        if mask_position:
            params['mask_position'] = mask_position
        
        try:
            # Read image
            img_data = self._read_image(image_path)
            
            # Call API
            result = self._make_request(ENDPOINT_ERASE, img_data, params)
            
            # Parse response (handle different API response formats)
            result_data = result['result']
            img_width, img_height = 0, 0
            
            if 'image' in result_data:
                # Format: result.image = base64 string
                image_bytes = self._decode_response_image(result_data['image'])
            elif 'image_list' in result_data and result_data['image_list']:
                # Format: result.image_list[0].image = base64 string
                img_item = result_data['image_list'][0]
                if isinstance(img_item, dict):
                    image_bytes = self._decode_response_image(img_item.get('image', ''))
                    img_width = img_item.get('width', 0)
                    img_height = img_item.get('height', 0)
                elif isinstance(img_item, str):
                    image_bytes = self._decode_response_image(img_item)
                else:
                    return EraseResult(success=False, message="Unknown image format in image_list")
            else:
                return EraseResult(success=False, message="No image data in response")
            
            return EraseResult(
                success=True,
                image_data=image_bytes,
                width=img_width,
                height=img_height,
                message="Handwriting erased successfully"
            )
            
        except Exception as e:
            logger.error(f"Erase failed: {e}")
            return EraseResult(success=False, message=str(e))
    
    def recognize_text(self, image_path: Union[str, Path],
                       character: int = 0) -> OCRResult:
        """
        Perform OCR text recognition on image.
        
        Uses TextIn's deep learning OCR (CRNN/Transformer based)
        with 99%+ accuracy on printed text.
        
        Args:
            image_path: Path to image
            character: 0=no character details(default), 1=full character info
        
        Returns:
            OCRResult with recognized text lines and positions
        """
        logger.info(f"OCR recognizing: {image_path}")
        
        params = {
            'character': character,
        }
        
        try:
            img_data = self._read_image(image_path)
            result = self._make_request(ENDPOINT_OCR, img_data, params)
            
            # Parse OCR result
            ocr_result = result.get('result', {})
            lines_data = ocr_result.get('lines', [])
            
            def parse_position(pos: list) -> tuple:
                """Convert 8-value polygon [x1,y1,x2,y2,x3,y3,x4,y4] to bbox (x,y,w,h)."""
                if not pos or len(pos) < 8:
                    return (0, 0, 0, 0)
                xs = pos[0::2]  # x1, x2, x3, x4
                ys = pos[1::2]  # y1, y2, y3, y4
                x_min, x_max = min(xs), max(xs)
                y_min, y_max = min(ys), max(ys)
                return (int(x_min), int(y_min), int(x_max - x_min), int(y_max - y_min))
            
            lines = []
            for line_data in lines_data:
                # Parse words
                words = []
                for word_data in line_data.get('words', []):
                    word = OCRWord(
                        text=word_data.get('word', ''),
                        confidence=word_data.get('score', word_data.get('confidence', 0)),
                        bbox=parse_position(word_data.get('position', word_data.get('location', []))),
                        poly=word_data.get('poly')
                    )
                    words.append(word)
                
                line = OCRLine(
                    text=line_data.get('text', ''),
                    confidence=line_data.get('score', line_data.get('confidence', 0)),
                    bbox=parse_position(line_data.get('position', line_data.get('location', []))),
                    words=words,
                    angle=line_data.get('angle', 0)
                )
                lines.append(line)
            
            return OCRResult(
                success=True,
                lines=lines,
                angle=ocr_result.get('angle', 0),
                width=ocr_result.get('width', 0),
                height=ocr_result.get('height', 0)
            )
            
        except Exception as e:
            logger.error(f"OCR failed: {e}")
            return OCRResult(success=False, message=str(e))
    
    def parse_document(self, image_path: Union[str, Path],
                       markdown_details: int = 1,
                       equation: int = 1,
                       table: int = 1) -> ParseResult:
        """
        Parse document with layout analysis.
        
        Uses TextIn xParse to:
        1. Recognize all text elements
        2. Classify element types (question number, text, option, mark)
        3. Detect red pen marks separately
        4. Output structured data with bounding boxes
        
        Args:
            image_path: Path to document image
            markdown_details: 0=simple, 1=detailed with positions
            equation: 0=skip equations, 1=recognize equations
            table: 0=skip tables, 1=recognize tables
        
        Returns:
            ParseResult with structured elements
        """
        logger.info(f"Parsing document: {image_path}")
        
        params = {
            'markdown_details': markdown_details,
            'equation': equation,
            'table': table,
        }
        
        try:
            img_data = self._read_image(image_path)
            result = self._make_request(ENDPOINT_XPARSE, img_data, params)
            
            # Parse elements
            elements = []
            raw_json = result.get('result', {})
            
            # Extract elements from various result fields
            for key in ['questions', 'text_blocks', 'elements', 'lines']:
                if key in raw_json:
                    for elem_data in raw_json[key]:
                        element = ParsedElement(
                            text=elem_data.get('text', ''),
                            element_type=elem_data.get('type', 'unknown'),
                            bbox=tuple(elem_data.get('bbox', elem_data.get('location', [0,0,0,0]))),
                            confidence=elem_data.get('confidence', 0),
                            attributes=elem_data
                        )
                        elements.append(element)
            
            return ParseResult(
                success=True,
                elements=elements,
                markdown=raw_json.get('markdown', ''),
                raw_json=raw_json
            )
            
        except Exception as e:
            logger.error(f"Parse failed: {e}")
            return ParseResult(success=False, message=str(e))
    
    def erase_and_recognize(self, image_path: Union[str, Path],
                            output_clean_path: Optional[str] = None) -> Tuple[EraseResult, OCRResult]:
        """
        Convenience method: erase handwriting + OCR in one call.
        
        Args:
            image_path: Original exam paper image
            output_clean_path: Optional path to save clean image
        
        Returns:
            Tuple of (EraseResult, OCRResult)
        """
        # Step 1: Erase
        erase_result = self.erase_handwriting(image_path)
        if not erase_result.success:
            return erase_result, OCRResult(success=False, message="Erase failed")
        
        # Save clean image if path provided
        if output_clean_path and erase_result.image_data:
            with open(output_clean_path, 'wb') as f:
                f.write(erase_result.image_data)
            logger.info(f"Clean image saved: {output_clean_path}")
        
        # Step 2: OCR on clean image
        # Save to temp file for OCR
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp.write(erase_result.image_data)
            tmp_path = tmp.name
        
        ocr_result = self.recognize_text(tmp_path)
        
        # Cleanup temp file
        Path(tmp_path).unlink(missing_ok=True)
        
        return erase_result, ocr_result
    
    def check_quota(self) -> Dict:
        """
        Check remaining API quota (if available via API).
        
        Returns:
            Dict with quota information
        """
        # TextIn doesn't provide a direct quota check API
        # Quota is visible in the console dashboard
        return {
            'message': 'Please check quota at https://www.textin.com/console/dashboard/overview',
            'console_url': 'https://www.textin.com/console/dashboard/overview'
        }


def create_client_from_config(config_path: Optional[str] = None,
                               app_id: Optional[str] = None,
                               secret_code: Optional[str] = None) -> TextInClient:
    """
    Create TextInClient from various config sources.
    
    Priority:
    1. Direct parameters
    2. Config file (JSON/YAML)
    3. Environment variables (TEXTIN_APP_ID, TEXTIN_SECRET_CODE)
    
    Args:
        config_path: Path to config file
        app_id: Direct app_id parameter
        secret_code: Direct secret_code parameter
    
    Returns:
        Configured TextInClient
    """
    import os
    
    # Priority 1: Direct parameters
    if app_id and secret_code:
        return TextInClient(app_id, secret_code)
    
    # Priority 2: Config file
    if config_path and Path(config_path).exists():
        with open(config_path, 'r') as f:
            config = json.load(f)
        return TextInClient(config['app_id'], config['secret_code'])
    
    # Priority 3: Environment variables
    env_app_id = os.environ.get('TEXTIN_APP_ID')
    env_secret = os.environ.get('TEXTIN_SECRET_CODE')
    if env_app_id and env_secret:
        return TextInClient(env_app_id, env_secret)
    
    raise ValueError(
        "TextIn credentials not found. Please provide:\n"
        "  1. Direct app_id and secret_code parameters, or\n"
        "  2. Config file with 'app_id' and 'secret_code', or\n"
        "  3. Environment variables TEXTIN_APP_ID and TEXTIN_SECRET_CODE"
    )
