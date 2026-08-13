"""Phase 1 main window.

Everything the employee needs is on one screen: current/next number,
today's count, printer + sync status, the print button, and a plain
log so problems are visible without opening a file. See module
docstrings in core/ticket_service.py and printing/printer_service.py
for the reliability logic this window drives.
"""
from __future__ import annotations

import logging
from datetime import date

from PySide6.QtCore import Qt, QTimer, Signal, QObject
from PySide6.QtGui import QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from app.config import AppConfig, save_config
from app.core.certificates import certificate_label
from app.core.database import Database
from app.core.models import TicketStatus
from app.core.session_service import SessionService
from app.core.ticket_service import TicketService
from app.logging_config import get_logger
from app.printing import printer_service, ticket_image
from app.printing.printer_service import PrintError
from app.printing.ticket_image import TicketImageError
from app.sync.supabase_client import SupabaseSyncClient, SupabaseUnavailable
from app.sync.sync_manager import SyncManager
from app.ui.certificate_dialog import ask_for_certificate
from app.ui.styles import STYLESHEET

logger = get_logger("ui")

# Gates the test-number button (once per session) and the admin reset
# (every time). Also checked server-side by the admin_reset_business_date
# RPC — see supabase/schema.sql — since the client-side check here is
# only a convenience, not a real security boundary for the cloud side.
ADMIN_PASSWORD = "11223344"


class _QtLogBridge(QObject):
    message = Signal(str)


class _QtLogHandler(logging.Handler):
    """Mirrors the standard logger into the on-screen log panel."""

    def __init__(self, bridge: _QtLogBridge):
        super().__init__()
        self.bridge = bridge
        self.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.bridge.message.emit(self.format(record))
        except Exception:
            pass


class MainWindow(QMainWindow):
    def __init__(self, config: AppConfig):
        super().__init__()
        self.config = config
        self.setWindowTitle("نظام طابور القبول — جامعة الزقازيق الأهلية")
        self.setLayoutDirection(Qt.RightToLeft)
        self.resize(560, 820)
        self.setStyleSheet(STYLESHEET)
        self._test_mode_unlocked = False

        # F11 toggles real fullscreen (kiosk-style, no window chrome).
        # The content column is centered with a max width (see
        # _build_ui) and the whole thing sits in a QScrollArea, so it
        # looks right whether the window is its default size, maximized,
        # or genuinely fullscreen on a large display — never stretched
        # edge-to-edge, never clipped.
        QShortcut(QKeySequence("F11"), self, activated=self._toggle_fullscreen)

        # Build the UI first: log messages emitted below must have a
        # log_panel to land in, and status labels to update.
        self._build_ui()

        self._log_bridge = _QtLogBridge()
        self._log_bridge.message.connect(self._append_log)
        logging.getLogger("queue_system").addHandler(_QtLogHandler(self._log_bridge))

        db_path = config.resolve_path(config.database.path)
        self.db = Database(db_path)
        self.session_service = SessionService(self.db)
        self.ticket_service = TicketService(self.db)
        self.supabase_client = SupabaseSyncClient(config.supabase)

        self.session = self.session_service.get_or_create_today()
        logger.info("Business session ready: %s (id=%s)", self.session.business_date, self.session.id)

        self.sync_manager = None
        if config.sync.enabled:
            self.sync_manager = SyncManager(
                self.ticket_service,
                self.session_service,
                self.supabase_client,
                interval_seconds=config.sync.interval_seconds,
                batch_size=config.sync.batch_size,
            )
            self.sync_manager.status_changed.connect(self._on_sync_status)
            self.sync_manager.start()
        else:
            self.sync_status_label.setText("المزامنة معطلة")
            self.sync_status_label.setObjectName("statusPending")

        self._date_check_timer = QTimer(self)
        self._date_check_timer.timeout.connect(self._check_day_rollover)
        self._date_check_timer.start(30_000)

        self._populate_printer_combo()
        self._refresh_all()

        # Deferred so the window shows up first — this makes one
        # synchronous network call, and must never be what an offline
        # employee is staring at a blank window waiting for.
        QTimer.singleShot(100, self._reconcile_with_server)

    # ---- UI construction ------------------------------------------------

    def _build_ui(self) -> None:
        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        logo_path = self.config.resolve_path("templates/university_logo.png")
        if logo_path.exists():
            logo_label = QLabel()
            pixmap = QPixmap(str(logo_path)).scaledToHeight(96, Qt.SmoothTransformation)
            logo_label.setPixmap(pixmap)
            logo_label.setAlignment(Qt.AlignCenter)
            layout.addWidget(logo_label)

        title = QLabel("جامعة الزقازيق الأهلية")
        title.setObjectName("title")
        title.setAlignment(Qt.AlignCenter)
        layout.addWidget(title)

        subtitle = QLabel("نظام طابور القبول")
        subtitle.setObjectName("sectionLabel")
        subtitle.setAlignment(Qt.AlignCenter)
        layout.addWidget(subtitle)

        self.date_label = QLabel()
        self.date_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.date_label)

        # Warning banner for an unresolved (failed/crashed) ticket
        self.warning_frame = QFrame()
        self.warning_frame.setObjectName("warningBanner")
        wl = QVBoxLayout(self.warning_frame)
        self.warning_label = QLabel()
        self.warning_label.setWordWrap(True)
        wl.addWidget(self.warning_label)
        wrow = QHBoxLayout()
        self.retry_button = QPushButton("إعادة الطباعة")
        self.retry_button.setObjectName("retryButton")
        self.retry_button.clicked.connect(self._on_retry_clicked)
        self.cancel_button = QPushButton("إلغاء هذا الرقم")
        self.cancel_button.setObjectName("cancelButton")
        self.cancel_button.clicked.connect(self._on_cancel_clicked)
        wrow.addWidget(self.retry_button)
        wrow.addWidget(self.cancel_button)
        wl.addLayout(wrow)
        layout.addWidget(self.warning_frame)
        self.warning_frame.hide()

        # Current number card
        current_card = self._card()
        cc_layout = QVBoxLayout(current_card)
        cc_label = QLabel("الرقم الحالي")
        cc_label.setObjectName("sectionLabel")
        cc_label.setAlignment(Qt.AlignCenter)
        self.current_number_label = QLabel("—")
        self.current_number_label.setObjectName("bigNumber")
        self.current_number_label.setAlignment(Qt.AlignCenter)
        # Confirms which certificate the number that just came out of
        # the printer was issued for — the employee's only chance to
        # notice a mis-tap before handing the ticket over.
        self.current_certificate_label = QLabel("")
        self.current_certificate_label.setObjectName("certificateLabel")
        self.current_certificate_label.setAlignment(Qt.AlignCenter)
        self.current_certificate_label.setWordWrap(True)
        cc_layout.addWidget(cc_label)
        cc_layout.addWidget(self.current_number_label)
        cc_layout.addWidget(self.current_certificate_label)
        layout.addWidget(current_card)

        # Next number card
        next_card = self._card()
        nc_layout = QVBoxLayout(next_card)
        nc_label = QLabel("الرقم التالي")
        nc_label.setObjectName("sectionLabel")
        nc_label.setAlignment(Qt.AlignCenter)
        self.next_number_label = QLabel("—")
        self.next_number_label.setObjectName("nextNumber")
        self.next_number_label.setAlignment(Qt.AlignCenter)
        nc_layout.addWidget(nc_label)
        nc_layout.addWidget(self.next_number_label)
        layout.addWidget(next_card)

        # Stats row: today's count / last printed
        stats_row = QHBoxLayout()
        stats_row.addWidget(self._stat_block("عدد اليوم", "today_count_label"))
        stats_row.addWidget(self._stat_block("آخر رقم مطبوع", "last_printed_label"))
        layout.addLayout(stats_row)

        # Printer + sync status row
        status_card = self._card()
        sc_layout = QVBoxLayout(status_card)

        printer_row = QHBoxLayout()
        printer_label = QLabel("الطابعة:")
        printer_row.addWidget(printer_label)
        # Explicit pick, persisted to config.yaml — Windows silently
        # reassigning its own "default printer" (e.g. to Microsoft
        # Print to PDF when the real printer is unplugged) must not
        # change what this app prints to. Selecting an entry here is
        # a deliberate override that survives restarts and outlives
        # the printer being unplugged/replugged.
        self.printer_combo = QComboBox()
        self.printer_combo.setObjectName("printerCombo")
        self.printer_combo.currentIndexChanged.connect(self._on_printer_selected)
        printer_row.addWidget(self.printer_combo, 1)
        self.printer_refresh_button = QPushButton("⟳")
        self.printer_refresh_button.setObjectName("printerRefreshButton")
        self.printer_refresh_button.setFixedWidth(36)
        self.printer_refresh_button.setToolTip("تحديث قائمة الطابعات")
        self.printer_refresh_button.clicked.connect(self._on_printer_refresh_clicked)
        printer_row.addWidget(self.printer_refresh_button)
        sc_layout.addLayout(printer_row)

        self.printer_status_label = QLabel()
        sc_layout.addWidget(self.printer_status_label)
        self.sync_status_label = QLabel("المزامنة: —")
        sc_layout.addWidget(self.sync_status_label)
        layout.addWidget(status_card)

        # Print button
        self.print_button = QPushButton("طباعة التذكرة التالية")
        self.print_button.setObjectName("printButton")
        self.print_button.clicked.connect(self._on_print_clicked)
        layout.addWidget(self.print_button)

        # Test button: runs the exact same reserve → mark-printed →
        # sync flow as a real print (numbers still advance, records
        # still sync to Supabase) but skips ticket_image.render_ticket_image
        # and printer_service.print_image entirely — nothing is sent
        # to the printer. One click, always available, no toggle to
        # remember to switch back off.
        self.test_button = QPushButton("سحب رقم تجريبي (بدون طباعة)")
        self.test_button.setObjectName("testModeButton")
        self.test_button.clicked.connect(self._on_test_clicked)
        layout.addWidget(self.test_button)

        # Admin reset: PIN-gated every time (unlike the test button,
        # which only asks once) since this deletes data. See
        # _on_reset_clicked.
        self.reset_button = QPushButton("إعادة تعيين النظام (Admin)")
        self.reset_button.setObjectName("resetButton")
        self.reset_button.clicked.connect(self._on_reset_clicked)
        layout.addWidget(self.reset_button)

        # Error banner
        self.error_label = QLabel("")
        self.error_label.setObjectName("statusError")
        self.error_label.setWordWrap(True)
        layout.addWidget(self.error_label)

        # Log panel — kept left-to-right: timestamps/technical messages
        # are English, so LTR reads naturally even inside an otherwise
        # RTL window.
        log_label = QLabel("سجل النشاط")
        log_label.setObjectName("sectionLabel")
        layout.addWidget(log_label)
        self.log_panel = QTextEdit()
        self.log_panel.setObjectName("logPanel")
        self.log_panel.setReadOnly(True)
        self.log_panel.setFixedHeight(140)
        self.log_panel.setLayoutDirection(Qt.LeftToRight)
        layout.addWidget(self.log_panel)

        # Cap the content column's width and center it horizontally so
        # maximizing or going fullscreen (F11) on a large/kiosk screen
        # doesn't stretch every card edge-to-edge — it just centers the
        # same layout with room to spare on both sides. The whole thing
        # sits in a scroll area too, so a short window (e.g. a small
        # laptop screen) scrolls instead of clipping the print button.
        root.setMaximumWidth(620)
        centering = QWidget()
        centering_layout = QHBoxLayout(centering)
        centering_layout.setContentsMargins(0, 0, 0, 0)
        centering_layout.addStretch(1)
        centering_layout.addWidget(root)
        centering_layout.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setWidget(centering)
        self.setCentralWidget(scroll)

    def _card(self) -> QFrame:
        f = QFrame()
        f.setObjectName("card")
        return f

    def _stat_block(self, title: str, attr_name: str) -> QFrame:
        card = self._card()
        v = QVBoxLayout(card)
        t = QLabel(title)
        t.setObjectName("sectionLabel")
        t.setAlignment(Qt.AlignCenter)
        val = QLabel("—")
        val.setObjectName("statValue")
        val.setAlignment(Qt.AlignCenter)
        v.addWidget(t)
        v.addWidget(val)
        setattr(self, attr_name, val)
        return card

    # ---- refresh / state -------------------------------------------------

    def _refresh_all(self) -> None:
        # ⁦/⁩ (LTR isolate) keep "2026-08-10" from being
        # visually reordered by the bidi algorithm inside the
        # surrounding Arabic (RTL) text — the "-" separators are
        # bidi-neutral and otherwise flip the digit groups around.
        self.date_label.setText(f"التاريخ: ⁦{self.session.business_date}⁩")

        stats = self.ticket_service.get_today_stats(self.session.id)
        self.current_number_label.setText(
            str(stats["current_number"]) if stats["current_number"] else "—"
        )
        self.current_certificate_label.setText(
            certificate_label(stats["current_certificate"]) if stats["current_number"] else ""
        )
        self.next_number_label.setText(str(stats["next_number"]))
        self.today_count_label.setText(str(stats["today_count"]))
        self.last_printed_label.setText(
            str(stats["current_number"]) if stats["current_number"] else "—"
        )

        available = printer_service.printer_is_available(self.config.printer.name)
        if available:
            self.printer_status_label.setText("حالة الطابعة: جاهزة")
            self.printer_status_label.setObjectName("statusReady")
        else:
            self.printer_status_label.setText("حالة الطابعة: غير موجودة")
            self.printer_status_label.setObjectName("statusError")
        self.printer_status_label.setStyleSheet("")  # force re-polish
        self.printer_status_label.style().unpolish(self.printer_status_label)
        self.printer_status_label.style().polish(self.printer_status_label)

        unresolved = self.ticket_service.get_unresolved_ticket(self.session.id)
        if unresolved:
            self.warning_frame.show()
            if unresolved.status == TicketStatus.RESERVED:
                self.warning_label.setText(
                    f"التذكرة رقم {unresolved.ticket_number} تم حجزها لكن لم يتم تأكيد طباعتها "
                    "(على الأرجح بسبب إعادة تشغيل البرنامج أو الجهاز أثناء الطباعة). "
                    "أعد المحاولة قبل طباعة رقم جديد."
                )
            else:
                self.warning_label.setText(
                    f"فشلت طباعة التذكرة رقم {unresolved.ticket_number}: "
                    f"{unresolved.error_message or 'خطأ غير معروف'}"
                )
            # The certificate is fixed at reservation time, so a retry
            # reprints the same number for the same certificate — no
            # need to ask again, but do show it so the employee can see
            # what they're about to hand over.
            self.retry_button.setText(
                f"إعادة طباعة الرقم {unresolved.ticket_number}"
                f" ({certificate_label(unresolved.certificate_type)})"
            )
            self.print_button.setEnabled(False)
            self.test_button.setEnabled(False)
        else:
            self.warning_frame.hide()
            self.print_button.setEnabled(True)
            self.test_button.setEnabled(True)

    def _append_log(self, line: str) -> None:
        self.log_panel.append(line)

    def _check_day_rollover(self) -> None:
        if self.session.business_date != date.today().isoformat():
            self.session = self.session_service.get_or_create_today()
            logger.info("New business day started: %s", self.session.business_date)
            self._refresh_all()

    def _populate_printer_combo(self, keep_selection: bool = False) -> None:
        """(Re)lists the printers Windows currently reports and re-selects
        whichever one is configured. `keep_selection` is used by the
        manual refresh button: if the previously-selected printer is
        gone from the new list (unplugged), it falls back to the
        configured name once that printer reappears rather than
        silently switching to something else."""
        target = self.config.printer.name
        printers = printer_service.list_printers()

        self.printer_combo.blockSignals(True)
        self.printer_combo.clear()
        self.printer_combo.addItem("(افتراضي Windows)", "")
        for name in printers:
            self.printer_combo.addItem(name, name)
        idx = self.printer_combo.findData(target)
        self.printer_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.printer_combo.blockSignals(False)

    def _on_printer_refresh_clicked(self) -> None:
        self._populate_printer_combo(keep_selection=True)
        self._refresh_all()
        logger.info("🔄 Printer list refreshed")

    def _on_printer_selected(self, index: int) -> None:
        name = self.printer_combo.itemData(index) or ""
        if name == self.config.printer.name:
            return
        self.config.printer.name = name
        try:
            save_config(self.config)
            logger.info("🖨️ Printer set to: %s", name or "(Windows default)")
        except Exception:
            logger.exception("Failed to save printer selection to config.yaml")
        self._refresh_all()

    def _toggle_fullscreen(self) -> None:
        if self.isFullScreen():
            self.showNormal()
        else:
            self.showFullScreen()

    def _prompt_admin_password(self, title: str) -> bool:
        """Shows a password-entry dialog; returns whether ADMIN_PASSWORD
        was entered (empty/cancelled counts as a normal, silent no)."""
        text, ok = QInputDialog.getText(self, title, "أدخل الرقم السري:", QLineEdit.Password)
        if not ok:
            return False
        if text != ADMIN_PASSWORD:
            QMessageBox.warning(self, title, "الرقم السري غير صحيح.")
            return False
        return True

    def _reconcile_with_server(self) -> None:
        """Best-effort startup check: if Supabase already has a higher
        ticket_number for today than this local database does (e.g.
        queue.db was lost/reset while the cloud mirror had newer synced
        tickets), raise the local numbering floor to match — see
        ticket_service.reconcile_sequence_floor. Never blocks/breaks
        printing: any failure here (offline, misconfigured, whatever)
        is just logged and otherwise ignored."""
        if not self.config.supabase.configured:
            return
        try:
            remote_max = self.supabase_client.get_max_ticket_number(self.session.business_date)
            if remote_max is None:
                return
            marker = self.ticket_service.reconcile_sequence_floor(
                self.session.id, remote_max, "Reconciled with Supabase at startup"
            )
            if marker is not None:
                logger.info(
                    "🔄 Local sequence was behind the server — jumped to #%s to match", remote_max
                )
                self._refresh_all()
        except SupabaseUnavailable as e:
            logger.warning("Startup server reconciliation skipped: %s", e)
        except Exception:
            logger.exception("Unexpected error during startup server reconciliation")

    # ---- printing workflow -------------------------------------------------

    def _on_print_clicked(self) -> None:
        self._print_next(test=False)

    def _on_test_clicked(self) -> None:
        if not self._test_mode_unlocked:
            if not self._prompt_admin_password("تفعيل وضع التجربة"):
                return
            self._test_mode_unlocked = True
            logger.info("🔓 Test mode unlocked for this session")
        self._print_next(test=True)

    def _print_next(self, test: bool) -> None:
        # Ask for the certificate BEFORE reserving anything: cancelling
        # the picker must leave the sequence untouched, so a mis-click
        # on the print button can never burn a ticket number.
        certificate_type = ask_for_certificate(
            self,
            "اختر نوع الشهادة (رقم تجريبي)" if test else "اختر نوع الشهادة",
        )
        if certificate_type is None:
            logger.info("Certificate selection cancelled — no number was reserved")
            return

        self.error_label.setText("")
        self.print_button.setEnabled(False)
        self.test_button.setEnabled(False)
        try:
            ticket = self.ticket_service.reserve_next_ticket(self.session.id, certificate_type)
            logger.info(
                "Reserved ticket #%s (%s)", ticket.ticket_number, certificate_label(certificate_type)
            )
            self._refresh_all()
            self._do_print(ticket, test=test)
        finally:
            self._refresh_all()

    def _on_retry_clicked(self) -> None:
        # Test-mode prints can't fail (no printer/template call to
        # fail at) so an unresolved ticket here is effectively always
        # from a real print attempt — retry it for real.
        unresolved = self.ticket_service.get_unresolved_ticket(self.session.id)
        if not unresolved:
            self._refresh_all()
            return
        self.error_label.setText("")
        self._do_print(unresolved, test=False)
        self._refresh_all()

    def _on_cancel_clicked(self) -> None:
        unresolved = self.ticket_service.get_unresolved_ticket(self.session.id)
        if not unresolved:
            return
        confirm = QMessageBox.question(
            self,
            "إلغاء رقم التذكرة",
            f"هل تريد إلغاء التذكرة رقم {unresolved.ticket_number}؟ الرقم لن يُعاد استخدامه — "
            "الطباعة التالية هتتخطاه. استخدم ده بس لو التذكرة فعلاً مش ممكن تتطبع.",
        )
        if confirm == QMessageBox.Yes:
            self.ticket_service.cancel_ticket(unresolved.id, "Cancelled by employee")
            logger.warning("Ticket #%s cancelled by employee", unresolved.ticket_number)
            self._refresh_all()

    def _on_reset_clicked(self) -> None:
        # PIN required every time (unlike the test button's one-time
        # unlock) since this deletes data — including on the server, if
        # reachable.
        if not self._prompt_admin_password("إعادة تعيين النظام"):
            return

        confirm = QMessageBox.warning(
            self,
            "إعادة تعيين النظام",
            f"هل أنت متأكد؟ هذا هيمسح كل تذاكر اليوم ({self.session.business_date}) محليًا "
            "وعلى السيرفر، ويرجّع الترقيم لرقم 1. الإجراء ده مش رجعة.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if confirm != QMessageBox.Yes:
            return

        removed = self.ticket_service.reset_session(self.session.id)
        logger.warning("🗑️ Admin reset: removed %s local ticket(s) for %s", removed, self.session.business_date)

        if self.config.supabase.configured:
            try:
                self.supabase_client.admin_reset_business_date(self.session.business_date, ADMIN_PASSWORD)
                logger.info("🗑️ Admin reset: cleared server tickets for %s", self.session.business_date)
            except SupabaseUnavailable as e:
                logger.warning("🗑️ Admin reset: server-side reset failed (local reset still applied): %s", e)
                QMessageBox.information(
                    self,
                    "إعادة تعيين النظام",
                    "اتعمل reset محلي بنجاح، لكن السيرفر مش متاح دلوقتي — هيفضل فيه بيانات "
                    "قديمة على Supabase لحد ما تتصل بالإنترنت وتعيد المحاولة يدويًا.",
                )

        self._refresh_all()

    def _do_print(self, ticket, test: bool = False) -> None:
        if test:
            # Same reserve → mark-printed → sync flow as a real print,
            # just without touching the template renderer or the
            # printer at all.
            self.ticket_service.mark_printed(ticket.id, "TEST_MODE")
            logger.info("🧪 Test mode: ticket #%s marked printed without printing", ticket.ticket_number)
            if self.sync_manager is not None:
                self.sync_manager.trigger()
            return

        temp_dir = self.config.resolve_path("data/temp")
        template_path = self.config.resolve_path(self.config.template.path)
        composited_path = None
        try:
            composited_path = ticket_image.render_ticket_image(
                template_path,
                ticket.ticket_number,
                temp_dir,
                self.config.template.number_padding,
            )
            printer_service.print_image(
                composited_path,
                self.config.printer.name,
                self.config.printer.copies,
            )
            self.ticket_service.mark_printed(ticket.id, self.config.printer.name or "default")
            logger.info("Ticket #%s printed successfully", ticket.ticket_number)
            if self.sync_manager is not None:
                self.sync_manager.trigger()  # sync this ticket now, don't wait for the next tick
        except (TicketImageError, PrintError) as e:
            self.ticket_service.mark_print_failed(ticket.id, str(e))
            logger.error("Ticket #%s failed to print: %s", ticket.ticket_number, e)
            self.error_label.setText(f"فشلت الطباعة: {e}")
        except Exception as e:  # unexpected — still must not silently claim success
            self.ticket_service.mark_print_failed(ticket.id, f"Unexpected error: {e}")
            logger.exception("Unexpected error printing ticket #%s", ticket.ticket_number)
            self.error_label.setText(f"خطأ غير متوقع: {e}")
        finally:
            if composited_path is not None:
                ticket_image.cleanup(composited_path)

    # ---- sync status ------------------------------------------------------

    def _on_sync_status(self, status: dict) -> None:
        pending = status["pending"]
        if status["online"] and pending == 0:
            self.sync_status_label.setText("المزامنة: كل التذاكر متزامنة")
            self.sync_status_label.setObjectName("statusReady")
        elif status["online"]:
            self.sync_status_label.setText(f"المزامنة: {pending} في الانتظار")
            self.sync_status_label.setObjectName("statusPending")
        else:
            self.sync_status_label.setText(
                f"المزامنة: غير متصل — {pending} في الانتظار "
                f"({status.get('last_error') or 'لا يوجد اتصال'})"
            )
            self.sync_status_label.setObjectName("statusError")
        self.sync_status_label.style().unpolish(self.sync_status_label)
        self.sync_status_label.style().polish(self.sync_status_label)

    # ---- lifecycle ----------------------------------------------------------

    def closeEvent(self, event) -> None:
        if self.sync_manager is not None:
            self.sync_manager.stop()
            self.sync_manager.wait(3000)
        self.db.close()
        super().closeEvent(event)
