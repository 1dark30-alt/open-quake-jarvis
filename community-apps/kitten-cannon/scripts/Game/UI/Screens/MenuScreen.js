import { Vector2D } from "../../../Lib/Math/Vector2D.js";
import Button from "../Button.js";

export default class MenuScreen {
    constructor(canvas2D_context, screens_sprite, button_font_family) {
        this.__ctx = canvas2D_context;
        this.__sprite_sheet = screens_sprite;
        this.__button_font_family = button_font_family;
        this.__frame = screens_sprite.getFrame("menu_screen.png");
        this.onStartClick = () => { };
        this.onHelpClick = () => { };
        this.onCreditsClick = () => { };
        this.buttons = {};
        this.visible = true;
        this.__create_buttons();
    }
    __create_buttons() {
        let canvas_w_half = this.__ctx.canvas.width / 2;
        let canvas_h_half = this.__ctx.canvas.height / 2;
        // Big touch targets: 80px text plus generous hit padding, 90px row spacing.
        let font_size = 80;
        let padding = new Vector2D(80, 10);
        this.__ctx.font = font_size + "px " + this.__button_font_family;

        let make = (text, row, onClick) => {
            let font_width = this.__ctx.measureText(text).width;
            // Button draws at position + padding/2, so shift left by half of both to center.
            let position = new Vector2D(canvas_w_half - font_width / 2 - padding.x / 2, canvas_h_half + 30 + row * 90);
            let button = new Button(this.__ctx, text, position, font_size, "#000", this.__button_font_family);
            button.padding = padding.copy();
            button.onClick = onClick;
            return button;
        };

        this.buttons["start"] = make("Start", 0, () => this.onStartClick());
        this.buttons["howToPlay"] = make("How To Play", 1, () => this.onHelpClick());
        this.buttons["credits"] = make("Credits", 2, () => this.onCreditsClick());



        // { // Start button
        //     let text = "Start";
        //     let font_width = this.__ctx.measureText(text).width;
        //     let position = new Vector2D(canvas_w_half - font_width * 3 / 2, canvas_h_half - 10);
        //     this.buttons["start"] = new Button(this.__ctx, text, position, 44, "#ff680b", "Nicotine");
        //     this.buttons["start"].onClick = () => {
        //         this.onStartClick();
        //     }
        // }



    }
    updateClickInput(cursor_position_vec) {
        if (!this.visible) return;
        if (!(cursor_position_vec instanceof Vector2D)) throw Error(" Cursor position should be a vector2D .");
        for (let button_key in this.buttons) {
            this.buttons[button_key].updateClickInput(cursor_position_vec);
        }
    }
    draw() {

        if (!this.visible) return;

        // Sky fill behind the art, then the art centered at its native aspect —
        // stretching it across a 4:1 panel canvas would distort it badly.
        let canvas_w = this.__ctx.canvas.width, canvas_h = this.__ctx.canvas.height;
        this.__ctx.fillStyle = "#dbedff";
        this.__ctx.fillRect(0, 0, canvas_w, canvas_h);
        let frame_w = canvas_h * (this.__frame.getWidth() / this.__frame.getHeight());
        this.__frame.draw(this.__ctx, canvas_w / 2 - frame_w / 2, 0, frame_w, canvas_h);

        for (let key in this.buttons) {
            this.buttons[key].draw();
        }

    }
}