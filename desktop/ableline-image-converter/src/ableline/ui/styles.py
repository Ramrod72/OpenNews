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
#DropArea {{
    background: #ffffff; border: 2px dashed #cbd5e1; border-radius: 12px;
}}
#DropArea[active="true"] {{ background: #eff6ff; border-color: {ACCENT}; }}
#DropTitle {{ font-size: 13pt; font-weight: 600; color: #111827; }}
#DropHint {{ color: #6b7280; }}
QListWidget {{
    background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 4px;
}}
QListWidget::item {{ padding: 3px 4px; }}
QListWidget::item:selected {{ background: #dbeafe; color: #111827; }}
QComboBox, QSpinBox, QLineEdit {{
    background: #ffffff; border: 1px solid #d1d5db; border-radius: 6px;
    padding: 4px 8px; min-height: 22px;
}}
QComboBox:focus, QSpinBox:focus, QLineEdit:focus {{ border-color: {ACCENT}; }}
QComboBox:disabled, QSpinBox:disabled, QSlider:disabled {{ color: #9ca3af; }}
QPushButton {{
    background: #ffffff; border: 1px solid #d1d5db; border-radius: 6px; padding: 5px 14px;
}}
QPushButton:hover {{ background: #f3f4f6; }}
QPushButton:disabled {{ color: #9ca3af; }}
QPushButton#LinkButton {{ border: none; background: transparent; color: #6b7280; padding: 2px; }}
QPushButton#LinkButton:hover {{ color: {ACCENT}; text-decoration: underline; }}
QPushButton#PrimaryButton {{
    background: {ACCENT}; color: #ffffff; border: none; border-radius: 8px;
    font-size: 12pt; font-weight: 600; padding: 12px 28px;
}}
QPushButton#PrimaryButton:hover {{ background: {ACCENT_HOVER}; }}
QPushButton#PrimaryButton:disabled {{ background: #93c5fd; }}
QPushButton#PrimaryButton[cancel="true"] {{ background: #dc2626; }}
QProgressBar {{
    background: #e5e7eb; border: none; border-radius: 4px; height: 8px; text-align: center;
}}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 4px; }}
#Status[state="ok"] {{ color: #15803d; }}
#Status[state="error"] {{ color: #b91c1c; }}
#Banner {{ background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; border-radius: 8px; padding: 8px; }}
"""
