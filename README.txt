== 五子棋 Gomoku (Rapfi AI) ==

【資料夾結構】
gomoku/
├── gomoku_v12.html                        ← 主程式
├── rapfi-worker.js                        ← AI Worker
├── rapfi-multi-simd128-relaxed.js         ← 你自己放進來
├── rapfi-multi-simd128-relaxed.wasm       ← 你自己放進來
└── nnue/
    ├── gomocalc-mix9svq.toml              ← 已包含
    ├── gomocalc-classical210901.toml      ← 已包含
    ├── gomocalc-classical220723.toml      ← 已包含
    ├── model210901.bin                    ← 已包含
    ├── model220723.bin                    ← 已包含
    ├── mix9svqstandard_bs15.bin.lz4       ← 你自己放進來
    ├── mix9svqrenju_bs15_black.bin.lz4    ← 你自己放進來
    ├── mix9svqrenju_bs15_white.bin.lz4    ← 你自己放進來
    └── mix9svqfreestyle_bsmix.bin.lz4     ← 你自己放進來

【啟動方式】
cd gomoku
python -m http.server 8080
瀏覽器開啟 http://localhost:8080/gomoku_v12.html
