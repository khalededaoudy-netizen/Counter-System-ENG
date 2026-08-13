"""Printing via Word COM automation.

Why Word COM rather than converting to PDF/image first: the ticket is
an existing .docx design (fonts, images, layout) and Word is the
one renderer guaranteed to reproduce it pixel-for-pixel, because it's
the same engine the template was authored in. Word is driven headless
(Visible=False) to open the filled-in copy, send it to the configured
printer, and close without saving — the template file itself is never
modified.

This module never touches the database; it only prints and reports
success/failure. The caller (ticket_service + UI workflow) is
responsible for turning that into a PRINTED/PRINT_FAILED transition.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

try:
    import win32com.client as win32
    import pywintypes
    import win32print
    import win32ui
    from PIL import Image, ImageWin
    _WINDOWS_AVAILABLE = True
except ImportError:  # non-Windows dev machine
    _WINDOWS_AVAILABLE = False


class PrintError(Exception):
    pass


def list_printers() -> list[str]:
    if not _WINDOWS_AVAILABLE:
        return []
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    return [p[2] for p in win32print.EnumPrinters(flags)]


def get_default_printer() -> Optional[str]:
    if not _WINDOWS_AVAILABLE:
        return None
    try:
        return win32print.GetDefaultPrinter()
    except Exception:
        return None


def printer_is_available(printer_name: str) -> bool:
    if not printer_name:
        return get_default_printer() is not None
    return printer_name in list_printers()


def print_docx(path: str | Path, printer_name: str = "", copies: int = 1) -> None:
    """Print `path` via Word. Raises PrintError on any failure — callers
    must treat that as PRINT_FAILED, never as success."""
    if not _WINDOWS_AVAILABLE:
        raise PrintError("Word COM automation is only available on Windows.")

    path = Path(path)
    if not path.exists():
        raise PrintError(f"Filled ticket file not found: {path}")

    if printer_name and not printer_is_available(printer_name):
        raise PrintError(f"Configured printer not found: {printer_name}")

    word = None
    doc = None
    try:
        word = win32.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0  # wdAlertsNone

        if printer_name:
            word.ActivePrinter = printer_name

        doc = word.Documents.Open(str(path), ReadOnly=True, AddToRecentFiles=False)
        doc.PrintOut(Background=False, Copies=copies)
    except pywintypes.com_error as e:
        raise PrintError(f"Word/printer COM error: {e}") from e
    except Exception as e:
        raise PrintError(f"Unexpected print error: {e}") from e
    finally:
        try:
            if doc is not None:
                doc.Close(SaveChanges=False)
        except Exception:
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass


def print_image(path: str | Path, printer_name: str = "", copies: int = 1) -> None:
    """Print a composited ticket PNG via raw GDI (no Word involved).

    Used by the image-based ticket pipeline (ticket_image.py): the
    template is pre-rendered once, the number is drawn onto a copy
    with PIL, and this just rasterizes that bitmap straight to the
    printer's device context, scaled to fill the printable width.
    Raises PrintError on any failure — callers must treat that as
    PRINT_FAILED, never as success.
    """
    if not _WINDOWS_AVAILABLE:
        raise PrintError("win32print/PIL are only available on Windows.")

    path = Path(path)
    if not path.exists():
        raise PrintError(f"Ticket image not found: {path}")

    if printer_name and not printer_is_available(printer_name):
        raise PrintError(f"Configured printer not found: {printer_name}")

    resolved_name = printer_name or get_default_printer()
    if not resolved_name:
        raise PrintError("No printer configured and no Windows default printer set.")

    try:
        img = Image.open(path)

        hdc = win32ui.CreateDC()
        hdc.CreatePrinterDC(resolved_name)

        printable_w = hdc.GetDeviceCaps(8)   # HORZRES
        printable_h = hdc.GetDeviceCaps(10)  # VERTRES

        scale = printable_w / img.width
        draw_w = printable_w
        draw_h = int(img.height * scale)
        draw_h = min(draw_h, printable_h)

        for _ in range(max(1, copies)):
            hdc.StartDoc(str(path))
            hdc.StartPage()
            dib = ImageWin.Dib(img)
            dib.draw(hdc.GetHandleOutput(), (0, 0, draw_w, draw_h))
            hdc.EndPage()
            hdc.EndDoc()
        hdc.DeleteDC()
    except pywintypes.com_error as e:
        raise PrintError(f"Printer COM error: {e}") from e
    except Exception as e:
        raise PrintError(f"Unexpected print error: {e}") from e
