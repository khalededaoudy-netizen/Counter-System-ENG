import numpy as np
from PIL import Image

from app.printing.ticket_image import TicketImageError, render_ticket_image


def _make_blank_template(path, size=(800, 600)):
    Image.new("RGB", size, "white").save(path)


def test_render_draws_number_inside_box(tmp_path):
    template_path = tmp_path / "template.png"
    _make_blank_template(template_path)
    box = (200, 200, 600, 400)

    out = render_ticket_image(
        template_path, 42, tmp_path / "out", number_padding=0, box=box, font_size=120
    )
    assert out.exists()

    im = Image.open(out).convert("L")
    arr = np.array(im)

    # something was drawn inside the box...
    inside = arr[box[1]:box[3], box[0]:box[2]]
    assert inside.min() < 250

    # ...and nothing was drawn outside it (template stayed blank elsewhere)
    outside_left = arr[:, : box[0] - 5]
    assert outside_left.min() == 255


def test_render_missing_template_raises(tmp_path):
    try:
        render_ticket_image(tmp_path / "nope.png", 1, tmp_path / "out", box=(0, 0, 10, 10))
        assert False, "expected TicketImageError"
    except TicketImageError:
        pass
