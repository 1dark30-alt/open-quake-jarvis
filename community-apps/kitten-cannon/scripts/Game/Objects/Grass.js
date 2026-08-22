import { Vector2D } from "../../Lib/Math/Vector2D.js";

export default class Grass {
    constructor(renderer, sprite_sheet) {
        this.__renderer = renderer;
        this.__sprite_sheet = sprite_sheet;
        this.__frame = sprite_sheet.getFrame("grass/1.png");

        let ar = this.__frame.getWidth() / this.__frame.getHeight();
        this.height = 200;
        this.width = this.height * ar;

        this.x = 0;
        this.y = this.__renderer.canvas.height - this.height + 2;
        // this.virtualPosXMax = this.__renderer.canvas.width - 250;

    }
    draw() {
        let camera = this.__renderer.camera;
        let camera_position = camera.getPosition();

        // Catch up even when the camera moves more than one tile per frame.
        while (camera_position.x >= this.x + this.width) {
            this.x += this.width;
        }
        // Tile across the whole viewport (the old code drew exactly two tiles,
        // which is not enough on a wide panel canvas). 4px overlap hides seams.
        let step = this.width - 4;
        let tiles = Math.ceil(camera.getWidth() / step) + 2;
        for (let i = 0; i < tiles; i++) {
            this.__renderer.drawFrame(this.__frame, this.x + i * step, this.y, this.width, this.height);
        }
    }
}