"""Composites the ticket number onto the pre-rendered template image.

The real template (templates/ticket_template.docx) turned out to place
its static design (logos, QR, Arabic labels) inside floating text
boxes that python-docx cannot edit reliably, and the ticket number was
never actual text in the file at all — just empty space reserved next
to the "رقم:" label. So instead of editing the .docx at print time,
the template is rendered ONCE to a high-resolution PNG
(templates/ticket_template_highres.png, exported via Word itself so
it matches real print output) and the ticket number is drawn directly
onto a copy of that image with PIL for every ticket. This is also a
better fit for an 80mm receipt-style layout than driving Word per
ticket.

The number is right-aligned within its box — flush-ish against the
right edge (near the "رقم:" label) but with a small gap so digits
don't touch the colon — and vertically centered, using English digits
in a bold sans-serif close to the template's font.

The print date/time line ("التاريخ و الوقت: ...") used to be baked
statically into the template image and has since been removed from
it, so it's drawn the same way as the ticket number: fresh onto the
copy at print time, using the actual moment of printing rather than a
fixed value. Unlike the ticket number (plain digits, no shaping
needed), this line is real Arabic text mixed with LTR digits, so it
must be run through arabic_reshaper (joins letters into their
correct positional forms) and python-bidi's get_display (produces
the correct visual left-to-right pixel order for the mixed-direction
line) before handing it to PIL — drawing the raw string directly
would render disconnected, wrong-shaped Arabic letters.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFont

# Box measured directly on templates/ticket_template_highres.png
# (3778x4416, exported from Word at 1200 DPI). Update these four
# numbers if the template image is ever re-exported at a different
# resolution/crop.
NUMBER_BOX = (798, 1699, 2156, 2193)  # left, top, right, bottom
FONT_SIZE = 440
RIGHT_GAP = 110  # px gap kept between the number and the "رقم:" label
FONT_CANDIDATES = (
    r"C:\Windows\Fonts\calibrib.ttf",  # Calibri Bold — closest widely-installed match to the template's Aptos
    r"C:\Windows\Fonts\arialbd.ttf",
)

# Center point + font size measured off the original template (before
# the static date/time line was removed from it), so the redrawn line
# lands exactly where it used to be printed.
DATETIME_CENTER = (1889, 4158)  # x, y — horizontal center is the page's own center
DATETIME_FONT_SIZE = 115


def _format_datetime_line(moment: datetime) -> str:
    period = "م" if moment.hour >= 12 else "ص"
    hour12 = moment.strftime("%I:%M")
    date_part = moment.strftime("%Y/%m/%d")
    return f"التاريخ و الوقت: {date_part} {hour12} {period}"


class TicketImageError(Exception):
    pass


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise TicketImageError("No bold font found; install Calibri or Arial.")


def render_ticket_image(
    template_image_path: str | Path,
    ticket_number: int,
    output_dir: str | Path,
    number_padding: int = 0,
    box: tuple[int, int, int, int] = NUMBER_BOX,
    font_size: int = FONT_SIZE,
    right_gap: int = RIGHT_GAP,
    datetime_center: tuple[int, int] = DATETIME_CENTER,
    datetime_font_size: int = DATETIME_FONT_SIZE,
) -> Path:
    template_image_path = Path(template_image_path)
    if not template_image_path.exists():
        raise TicketImageError(f"Template image not found: {template_image_path}")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    text = str(ticket_number).zfill(number_padding) if number_padding else str(ticket_number)

    im = Image.open(template_image_path).convert("RGB")
    draw = ImageDraw.Draw(im)
    font = _load_font(font_size)

    left, top, right, bottom = box
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    x = right - right_gap - text_w - bbox[0]            # right-aligned, with a gap before "رقم:"
    y = top + (bottom - top - text_h) // 2 - bbox[1]    # vertically centered in the box

    draw.text((x, y), text, font=font, fill=(0, 0, 0))

    datetime_line = _format_datetime_line(datetime.now())
    datetime_display = get_display(arabic_reshaper.reshape(datetime_line))
    datetime_font = _load_font(datetime_font_size)
    draw.text(datetime_center, datetime_display, font=datetime_font, fill=(0, 0, 0), anchor="mm")

    out_path = output_dir / f"ticket_{text}_{uuid.uuid4().hex[:8]}.png"
    im.save(out_path)
    return out_path


def cleanup(path: str | Path) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass
