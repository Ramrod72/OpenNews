"""Application stylesheet (light, minimalist)."""

ACCENT = "#2563eb"
ACCENT_HOVER = "#1d4ed8"

STYLESHEET = f"""
QWidget {{
    font-family: "Segoe UI", "Inter", sans-serif;
    font-size: 10pt;
    color: #1f2937;
}}
QMainWindow, #Central {{ background: #f6f7f9; }}
#Title {{ font-size: 17pt; font-weight: 600; color: #111827; }}
#Subtitle {{ color: #6b7280; }}
#Card {{ background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; }}
#SectionLabel {{ font-weight: 600; color: #374151; }}
#Muted {{ color: #6b7280; }}
QLineEdit {{
    background: #ffffff; border: 1px solid #d1d5db; border-radius: 6px;
    padding: 4px 8px; min-height: 22px;
}}
QLineEdit:focus {{ border-color: {ACCENT}; }}
QLineEdit#QueryBox {{ font-size: 13pt; padding: 8px 12px; min-height: 26px; }}
QPushButton {{
    background: #ffffff; border: 1px solid #d1d5db; border-radius: 6px; padding: 5px 14px;
}}
QPushButton:hover {{ background: #f3f4f6; }}
QPushButton:disabled {{ color: #9ca3af; }}
QPushButton#LinkButton {{ border: none; background: transparent; color: #6b7280; padding: 2px; }}
QPushButton#LinkButton:hover {{ color: {ACCENT}; text-decoration: underline; }}
QPushButton#PrimaryButton {{
    background: {ACCENT}; color: #ffffff; border: none; border-radius: 8px;
    font-size: 12pt; font-weight: 600; padding: 9px 28px;
}}
QPushButton#PrimaryButton:hover {{ background: {ACCENT_HOVER}; }}
QPushButton#PrimaryButton:disabled {{ background: #93c5fd; }}
QPushButton#Chip {{ border-radius: 12px; padding: 3px 12px; color: #374151; }}
QPushButton#Chip:checked {{ background: #dbeafe; border-color: {ACCENT}; color: #1e3a8a; }}
QTableView {{
    background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px;
    gridline-color: #f1f5f9; selection-background-color: #dbeafe; selection-color: #111827;
}}
QHeaderView::section {{
    background: #f9fafb; border: none; border-bottom: 1px solid #e5e7eb;
    padding: 5px 8px; font-weight: 600; color: #374151;
}}
QProgressBar {{
    background: #e5e7eb; border: none; border-radius: 3px; max-height: 6px;
}}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}
#Status[state="ok"] {{ color: #15803d; }}
#Status[state="warn"] {{ color: #b45309; }}
#Status[state="error"] {{ color: #b91c1c; }}
#MatchCount {{ font-weight: 600; color: #111827; }}
#Banner {{ background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; border-radius: 8px; padding: 8px; }}
"""
