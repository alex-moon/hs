#!/bin/bash

source .venv/bin/activate
python3 scraper.py
node report.js
