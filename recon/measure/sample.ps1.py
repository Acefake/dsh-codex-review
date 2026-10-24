import sys
from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
print("size", im.size)
pts = {
 "topbar_bg": (1200, 18),
 "window_right_btns": (2410, 25),
 "titlebar_left_menu": (120, 18),
 "nav_rail_bg": (30, 900),
 "nav_rail_bg2": (40, 620),
 "sidebar_bg": (200, 900),
 "sidebar_header_bg": (150, 75),
 "sidebar_selected_item": (250, 208),
 "sidebar_item_plain": (250, 480),
 "search_box_bg": (200, 118),
 "divider_rail_sidebar": (95, 700),
 "main_bg": (900, 900),
 "main_toolbar_bg": (800, 122),
 "tab_active_text": (350, 122),
 "btn_review_bg": (1450, 122),
 "btn_merge_bg": (1630, 122),
 "open_badge_bg": (452, 167),
 "pr_title_text": (600, 208),
 "branch_text": (700, 241),
 "h2_text": (430, 387),
 "body_text": (500, 420),
 "code_bg": (905, 458),
 "code_text": (860, 458),
 "right_bg": (1400, 900),
 "right_head_text": (1265, 172),
 "chip_24files_bg": (1300, 208),
 "right_section_label": (1240, 260),
 "bottom_bar_bg": (1000, 1035),
 "chat_input_bg": (1350, 1035),
 "chat_input_border": (1134, 1035),
 "plus_btn_bg": (1145, 1035),
 "add_green": (700, 122),
 "del_red": (738, 122),
 "sidebar_item_title": (150, 192),
 "nav_icon_active": (28, 113),
}
for k,(x,y) in pts.items():
    print(k, (x,y), im.getpixel((x,y)))
# Dominant colors overall
small = im.resize((200,120))
from collections import Counter
c = Counter(small.getdata())
print("TOP COLORS:", c.most_common(12))
